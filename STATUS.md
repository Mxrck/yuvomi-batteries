# STATUS — turno A (Fases 0 y 1), 2026-11-23

Plan vigente: `~/.hermes/plans/2026-11-23_0930-yuvomi-modulo-baterias-v3.md`.
Rama de trabajo: **`feat/dominio`** (no se hizo commit en `main`; el merge lo decide la revisión).

## Hecho

- Repo `Mxrck/yuvomi-batteries` (público, MIT), clonado en `~/repositories/yuvomi-batteries`.
  Estructura de carpetas, `.gitignore`, `package.json` (`type: module`, script `test`) y `README.md`
  con "Probado contra Yuvomi 2.94.0" y el aviso de que es código propio que, instalado por copia,
  Yuvomi sirve sin su paso de aprobación.
- **Puerto 8184** en `192.168.50.211`: libre hoy (`curl http://192.168.50.211:8184/` → exit 7,
  conexión rechazada). Anotado en el README; hay que volver a comprobarlo justo antes de `install_app`.
- `service/app/db.mjs`: `foreign_keys = ON`, `journal_mode = WAL` (en archivos; `:memory:` no tiene
  WAL), `busy_timeout = 5000`, migraciones por `PRAGMA user_version` (idempotentes, cada una en su
  transacción) y la migración 1 con el schema completo: `pools` + `pools_identity`, `allocations`
  (`kind`/`slug`/`closed_on`/`closed_reason`/`request_id`) + `one_missing_per_pool` + `by_pool_place`,
  `movements`, y los **tres triggers** de la invariante (`trg_alloc_guard_ins`, `trg_alloc_guard_upd`,
  `trg_pool_total_guard`). `closeDb()` hace `wal_checkpoint(TRUNCATE)` para que una copia del
  archivo (respaldo de Umbrel) quede completa.
- `service/app/places.mjs`: dominio con una sola primitiva interna `move()` y las operaciones
  públicas `createPool`, `updatePool`, `archivePool`, `place`, `moveTo`, `find`, `change`, `discard`,
  `summary`, `placesList`, `placeHistory`.
  - *Sin ubicar* se recalcula dentro de la misma transacción tras cada mutación
    (`missing = total − Σ device+charger+drawer`); si queda negativo → `stock_exceeded` con desglose;
    si da 0, la fila se cierra; si vuelve a ser positivo, se reabre.
  - Todo es síncrono (`DatabaseSync` + `BEGIN IMMEDIATE`): **no hay `await` ni `async`** en
    `service/app/` (verificado con grep). `movements` y el registro de idempotencia se escriben en
    la misma transacción.
- `service/app/time.mjs`: `todayIn`/`ageDays` sobre el calendario de `America/Merida`, sin depender
  del TZ del proceso; `slugify` estable (minúsculas, sin acentos, guiones); `isIsoDate`.
- `service/app/errors.mjs`: `DomainError {code numérico, reason, message, details}` con `toJSON()`
  listo para serializar como `{error, code, reason, details}`; `fromSqlite()` convierte el abort de
  los triggers y la violación de `pools_identity` en 409, para que una regla que solo aplica la base
  no salga como 500.
- **Tests: 47, todos en verde** (`npm test`, un solo `node --test`; estables en 3 corridas
  seguidas). Node 22.22.3: `node:sqlite` funciona **sin flag**; el script usa
  `--disable-warning=ExperimentalWarning` solo para no ensuciar la salida.

| Paso del plan | Test |
|---|---|
| 5 | `5 · creating a pool creates Sin ubicar…` (+ `5b` total 0) |
| 6 | `6 · place takes from Sin ubicar…` (+ `6b`, `6b2`, `6c`) |
| 7 | `7 · placing more than the stock is stock_exceeded and writes nothing` |
| 8 | `db.test.mjs`: insert, update y total de pool saltándose el código (3 tests) |
| 9 | `9 · a partial move (3 of 5)…` |
| 10 | `10 · moving into an existing place adds…` (+ `10b`–`10e`) |
| 11 | `change-find.test.mjs` `11`, `11` (insufficient_drawer, nada cambia), `11b`–`11g` |
| 12 | `12 · find moves out of Sin ubicar…` (+ `12b`) |
| 13 | `13 · discard lowers the total…` (+ `13b`) |
| 14 | `14 · lowering the total below what is placed…` (+ `14b`) |
| 15 | `15 · pool_exists ignores case and spaces…` (+ índice en `db.test.mjs`) |
| 16 | `16 · archiving leaves the pool out of the summary…` |
| 17 | `17 · request_id: same payload…` |
| 18 | `18 · every mutation writes movements…` |
| 19 | `19 · placesList reports age_days…` + `time.test.mjs` (medianoche) |
| extra | invariante con 600 operaciones aleatorias en 3 semillas (`Σ lugares = total` tras cada paso), agrupación por lugar, historial por lugar, validación de entradas, mapeo de errores SQLite |

## Pendiente

- **Fase 0, paso 3** (levantar `docker-compose.dev.yml` y probar ahí la instalación de la página
  desde el sidecar): no se hizo en este turno porque el encargo excluye contenedores e imágenes.
  Corresponde al turno C, que es cuando existe la página.
- **Turno B**: `auth.mjs`, `server.mjs`, `mcp.mjs`. Dos cosas del plan que quedan para ahí y no para el
  dominio:
  - `resumen_humano`: el dominio devuelve `{operation, legs:[{role?, pool_id, pool_name, quantity,
    from, to}], pools}`, suficiente para armar la línea en español sin volver a consultar.
  - plantilla implícita (inferir `cantidad`/`tipo` del último uso del lugar) para las tools del MCP.
    Los datos ya están: el último `movements`/`allocations` de ese `slug`.
  - Llamar a `closeDb()` en `SIGTERM`/`SIGINT`.
- `checked_on` (botón "Siguen aquí"): la columna existe; la operación es de v1.1.

## Decisiones tomadas (y desviaciones del plan)

1. **`by_pool_place` es `UNIQUE`**, no un índice simple. El plan dice "mover a un lugar existente
   suma"; para eso tiene que haber exactamente una fila activa por pool y lugar. El índice lo
   garantiza en la base.
2. **La idempotencia vive en una tabla `requests`** (`request_id` PK, operación, payload canónico,
   resultado). `allocations.request_id` se conserva, pero **sin `UNIQUE`**: solo dice qué petición
   creó la fila. Motivo: una operación puede tocar varias filas (cambiar pilas de un aparato con dos
   pools crea dos) o ninguna (mover a un lugar existente solo suma). Con `UNIQUE` por fila, el segundo
   insert de la misma petición fallaría. El mismo `request_id` con otra operación o con otro payload
   → `409 request_id_reused`.
3. **`movements` lleva además `from_slug`/`to_slug`** (con índice). El historial por lugar
   (`GET /places/:slug/history`) necesita buscar por slug, y SQLite no puede sacar el slug de una
   etiqueta con acentos dentro de la consulta.
4. **Contradicción del plan resuelta (origen de "poner"):** la tabla REST dice "por defecto desde
   `drawer`", pero los pasos 6/7 dicen que poner descuenta de *Sin ubicar* y que exceder es
   `stock_exceeded`. Regla implementada:
   - destino **aparato** → sale del cajón del pool si existe (uno solo). Si el cajón no alcanza →
     `insufficient_drawer` (nunca se completa en silencio con *Sin ubicar*). Si hay dos cajones →
     `ambiguous_target`. Si el pool no tiene cajón → sale de *Sin ubicar*;
   - destino **cargador o cajón** → sale de *Sin ubicar*: es registrar pilas que aparecieron ahí. Un
     test lo había delatado: registrar "2 en el cargador" las estaba sacando del cajón;
   - `from_slug` explícito siempre manda (por ejemplo `sin-ubicar` cuando el cajón no alcanza).
5. **Nombre de la operación pública de mover: `moveTo`**. La primitiva interna se llama `move()`,
   como pide el plan. `moveTo` es la fachada de `POST /places/move`: sin `quantity` mueve el lugar
   entero (todas sus pools); con `quantity` en un lugar de varias pools exige `pool_id`
   (`ambiguous_target`). Mover a "Sin ubicar" es *perder*: el total no cambia.
6. **Errores**: a los siete del encargo se suman `invalid_input` (400) y `place_not_found` (404).
   `allocation_closed` (409) significa "ese lugar existió pero ya no tiene pilas".
7. **Zona horaria por `HOUSEHOLD_TZ`** (por defecto `America/Merida`), no por `TZ`. Así el resultado
   no depende de la máquina: los tests corren en UTC y el contenedor también puede hacerlo.
8. Al **sumar a un lugar existente**, `placed_on` pasa a la fecha de la última adición. *Cambiar
   pilas*, en cambio, cierra la fila vieja y abre una nueva con la fecha de hoy, así que la antigüedad
   del aparato queda exacta.
9. **Cambiar pilas**: las nuevas salen del cajón de la misma pool (o de `new_pool_id`) en igual
   cantidad (o `new_quantity`); los dos overrides solo se aceptan en un aparato con una sola pool.
   Para `old_to` cargador o cajón se usa el único de la casa que esté activo; si no hay ninguno
   activo, el último usado; si nunca hubo, se crea "Cargador"/"Cajón". Con dos activos →
   `ambiguous_target`. El cajón se valida **antes** de escribir nada, y la transacción garantiza el
   todo o nada.
10. **Archivar** cierra los lugares activos del pool con `closed_reason = 'moved'` (el schema solo
    admite `moved`/`discarded`), deja un movimiento `pool_archived` y libera la identidad, de modo que
    se puede crear de nuevo el mismo pool. Un pool archivado no acepta escrituras (`pool_not_found`).
11. El `kind` del pool se guarda en mayúsculas (`aaa` → `AAA`); la marca y la línea, tal como se
    escriben (solo se recortan espacios). La identidad ya compara sin distinguir mayúsculas.
12. El nombre "Sin ubicar" (slug `sin-ubicar`) está reservado: `place` y `find` lo rechazan como
    destino, y `moveTo` lo acepta como "perder".
