# STATUS

Plan vigente: `~/.hermes/plans/2026-11-23_0930-yuvomi-modulo-baterias-v3.md`.

---

# Turno B (Fases 2 y 3), 2026-11-23 — sobre `main`

## Hecho

- **`service/app/auth.mjs`**: cookie de sesión de Yuvomi (`yuvomi.sid`) **o**
  `Authorization: Bearer <token>`, nunca las dos (`400 credentials_conflict`). La credencial se
  reenvía tal cual a `${YUVOMI_INTERNAL_URL}/api/v1/auth/me` junto con `X-Forwarded-For`; con Bearer
  no se manda ninguna cookie a Yuvomi. Permisos desde `permissions.modules['ext:batteries']`, con
  override `user.role === 'admin'` o `permissions.admin === true` ⇒ `write`. Fuera de
  `access_scope === 'family'` → `403 family_scope_required` (fail closed si falta). Caché por hash de la
  credencial: 5 s si es válida, 2 s si Yuvomi responde 401/403, **sin caché** para 5xx o errores de red
  (`502 yuvomi_unavailable`). CSRF solo con cookie: `Origin === PUBLIC_ORIGIN` y `x-csrf-token` igual a
  la cookie `csrf-token`.
- **`service/app/server.mjs`** (`node:http` puro). Todas las rutas de la tabla del plan bajo
  `/api/extensions/batteries`, más `POST …/mcp`. Orden fijo: credencial → `/auth/me` → permiso → CSRF →
  ruta, así que **401 llega antes que 404** y un anónimo no descubre rutas. Respuestas `{data,
  resumen_humano?}`; errores `{error, code, reason, details?}` con `code` numérico; 405 con `Allow`,
  415, 413 (64 KB), `invalid_json`. Log de una línea JSON por request (método, path sin query,
  status, ms); **nunca** cabeceras ni cuerpos. `SIGTERM`/`SIGINT` → `server.close()` + `closeDb()`.
- **`service/app/humanize.mjs`**: `resumen_humano` en español para cada mutación, más `poolLine` y
  `placeLine` para las lecturas del agente.
- **`service/app/mcp.mjs`**: Streamable HTTP mínimo con respuestas JSON (sin SSE ni sesiones).
  `initialize` negocia la versión (`2025-11-25`, `2025-06-18`, `2025-03-26`; ante una versión
  desconocida responde `2025-11-25`), `notifications/*` → 202, `ping`, `tools/list` y `tools/call`.
  GET/DELETE → 405, método desconocido → -32601, mensaje inválido → -32600, JSON roto → -32700,
  batch soportado. Las **8 tools de intención** del plan. Los errores de dominio salen como
  `isError: true` con `{error, code, reason, details}`. Lecturas con permiso `read`, escrituras con
  `write`, comprobado por tool.
- **Dominio** (`places.mjs`), lo que pedía el MCP para no tener lógica propia:
  `addStock`, `receiveStock` ("compré 12": suma o crea; dos candidatos → ambiguo), `lastUse`
  (plantilla implícita), `resolvePlace` (nombre aproximado → un lugar, o `ambiguous_target` con
  candidatos), `resolveDestination` (destino **sin** coincidencia aproximada), `resolvePool`,
  `matchPools` y `runIdempotent`.
- **Tests: 77 en verde** (eran 47) en un solo `npm test`, estables en 3 corridas. Por archivo: auth
  6, server 8, mcp 6, resolve 8, humanize 2, más los 47 del turno A. Doble de `/auth/me` con `fetch`
  inyectado, así que CI no depende de Yuvomi. **Prueba de que los tests detectan regresiones**:
  anular `assertCsrf` tumba 2 tests y quitar el override de admin tumba 13.

| Paso del plan | Test |
|---|---|
| 20 | `auth: 20 · no credential is 401…`, `server: 20 · no credential → 401…` |
| 21 | `auth.mjs` (los 6 tests de `auth.test.mjs`, incluido el de caché 5 s/2 s/sin caché en 5xx) |
| 22 | `auth: 22 · read can GET but not POST…`, `server: 22 · …` |
| 23 | `auth: 23 · CSRF…`, `server: 23 · cookie + foreign Origin → csrf_invalid and nothing written…` |
| 24 | `server: 24 · every mutation route answers data + resumen_humano…` (8 rutas) |
| 25 | **pendiente (turno C)**: el grep contra `innerHTML` interpolado solo tiene sentido cuando exista la UI |
| 26 | `mcp: 26 · initialize…/tools/list…`, `mcp: 26 · invalid Bearer → 401…` |
| 27 | `mcp.mjs`, y el flujo completo `the agent flow: …` |
| 28 | `mcp: 28 · an ambiguous place returns candidates as a tool error and writes nothing` |
| 29 | sustituido: ver *Verificación real*, punto 6 |

## Verificación real (servidor local, Yuvomi 2.94.0 de producción como `/auth/me`)

Servidor: `PORT=18184 YUVOMI_INTERNAL_URL=http://192.168.50.211:8180
PUBLIC_ORIGIN=https://familia.marcomaldonado.com HOUSEHOLD_TZ=America/Merida
DB_PATH=/tmp/batteries-turnoB.db node service/app/server.mjs`. El token se leyó de `~/.hermes/.env`
(`YUVOMI_MCP_TOKEN`) sin imprimirlo; un grep confirma que no aparece en ningún archivo del repo.

1. `curl …/health` sin credencial → **200** `{"ok":true}`.
2. `curl …/summary` sin credencial → **401** `{"error":"Not authenticated.","code":401,"reason":"not_authenticated"}`.
3. `curl …/summary` con Bearer → **200** `{"data":[]}` (base vacía), con identidad tomada de
   `/auth/me`. Lo que devolvió Yuvomi para ese token: `user {id:1, role:"admin",
   access_scope:"family", display_name:"Marco"}`, `permissions.admin: true`, y `permissions.modules`
   con los 15 módulos de core (`calendar`, `tasks`, `notes`, `contacts`, `meals`, `shopping`, `pantry`,
   `inventory`, `budget`, `documents`, `housekeeping`, `waste`, `rewards`, `health`, `schedule`) en
   `write` más `ext:cleaningplan: write`. **No trae `ext:batteries`** porque el módulo aún no está
   instalado: escribe por el override de admin. El token es de acceso total (sin scopes).
4. `POST …/pools` con Bearer → **201**. `POST …/places/place` con Bearer, **sin CSRF** y con
   `Origin: https://evil.example` → **200**, resumen *"Tren Thomas de Ángel: 3 AAA Duracell Recharge
   (desde Sin ubicar)"*; en `movements` quedó `actor_user_id 1`, `actor_name "Marco"`, `via "ui"`.
   El mismo POST con cookie falsa (`yuvomi.sid=falsa123`) y Origin ajeno → **401** (Yuvomi rechaza la
   sesión antes de llegar al CSRF; el 403 `csrf_invalid` con sesión válida está cubierto por los tests,
   porque no hay sesión real de navegador que usar aquí). Repetido con el Origin correcto → 401
   servido desde la caché de 2 s (1 ms en el log).
5. Handshake MCP con `curl`: `initialize` → `protocolVersion 2025-11-25`, `capabilities.tools`,
   `serverInfo yuvomi-batteries 0.1.0`; `notifications/initialized` → **202**; `tools/list` → las 8
   tools; `tools/call resumen` → *"AAA Duracell Recharge: 24 = 3 en aparatos · 0 en cargador · 0 en
   cajón · 21 sin ubicar"*; `cambiar_pilas {lugar:"el tren thomas"}` → `isError` con
   `insufficient_drawer {needed:3, available:0}` (correcto: no había cajón, y no escribió nada);
   Bearer inválido → **401**.
6. **Cliente MCP real**: el SDK de Hermes (`mcp 2.0.0` del venv de hermes-agent) conectado como lo
   hace su transporte, con `httpx2` y la cabecera `mcp-protocol-version` sembrada desde el handshake
   (script en `~/.hermes/profiles/claudio/cache/scratch/mcp-client-check/check.py`, fuera del repo).
   Resultados: `initialize → 2025-11-25`, `list_tools` → las 8, `resumen` y `donde_estan` correctos
   (*"…puestas hace 11 días"* para el 12/nov, calendario de Mérida) y `ping` ok. El SDK solo hizo
   POST: ni GET de SSE ni DELETE, porque no hay `Mcp-Session-Id`. No se usó `hermes mcp test`
   porque exige registrar el servidor en `config.yaml`, que este turno prohíbe; queda para el turno D.
7. `kill -TERM`: log `SIGTERM: closing`, el proceso termina, y el `-wal` de 115 KB queda integrado en
   el archivo principal (desaparecen `-wal`/`-shm`). Así la copia de respaldo queda completa.

`/tmp/batteries-turnoB.db` **sigue ahí** para la revisión de Hermes (1 pool, 1 lugar, 2 movimientos).

## Desviaciones y decisiones del turno B

1. **La idempotencia de las tools MCP va por tool, no por operación de dominio.** Las tools
   resuelven nombres contra el estado antes de escribir, así que un reintento podía tomar otro
   camino. Ejemplos: `agregar_stock` crea el pool la primera vez y lo *suma* la segunda; `mover` de un
   lugar entero falla en el reintento porque el origen ya está vacío. Por eso cada tool de escritura
   corre entera en `runIdempotent(db, 'mcp:<tool>', argumentos_crudos, …)`: **una transacción y un
   `request_id`** para resolución + escritura. `mutation()` se volvió **reentrante**: una operación
   llamada dentro de otra se une a su transacción. Efecto adicional: resolver y escribir es atómico.
2. **Destinos sin coincidencia aproximada.** `resolvePlace` (origen: "el tren de Percy") sí acepta
   coincidencias parciales, con ambigüedad explícita. `resolveDestination` no: un nombre parecido a un
   lugar existente suele ser un aparato *nuevo* ("Control minisplit" no es "Control TV"), y meter pilas
   en el lugar equivocado en silencio es justo el error que el módulo existe para evitar. Excepción:
   las palabras sueltas "cargador"/"cajón" usan el único de la casa (con dos → ambiguo).
3. **Plantilla implícita**: sin `cantidad` y/o sin pool, se usa el último reparto de **ese lugar**
   (`lastUse`), solo si coincide con los filtros dados. Entre varios pools posibles, el último uso del
   lugar desempata. Si no hay uso previo, ambiguo. La cantidad se infiere solo si el pool coincide.
4. **`donde_estan` con un nombre ambiguo lista todos los candidatos** en vez de fallar: es una
   pregunta, no una escritura. Solo las escrituras se niegan a elegir.
5. **`agregar_stock` → `receiveStock`** en el dominio: suma al pool que coincide con los campos dados
   o lo crea; con dos candidatos (misma marca, distintas líneas) → `ambiguous_target`.
6. **Herramientas en español con argumentos en español** (`lugar`, `cantidad`, `tipo`, `marca`,
   `linea`, `desde`, `hacia`, `viejas_a: cargador|cajon|basura`, `clase_lugar: aparato|cargador|cajon`,
   `cantidad_nueva`, `fecha`, `delta`, `request_id`). Respecto a la tabla del plan se agregaron
   `clase_lugar` (para crear un cargador o cajón nuevo), `desde`, `fecha` y `cantidad_nueva`.
   `viejas_a` toma `cargador` por defecto.
7. **Cookie de sesión = `yuvomi.sid`** (según `components.securitySchemes.cookieAuth` del OpenAPI
   2.94.0). Una petición con Bearer puede traer otras cookies (Cloudflare, etc.) sin conflicto; solo
   choca si trae también `yuvomi.sid`.
8. **Un 403 de `/auth/me` se trata como 401** (credencial no válida para nosotros, cacheada 2 s). Un
   5xx es `502 yuvomi_unavailable` y no se cachea.
9. **El MCP exige `read` a nivel HTTP** (para que `tools/list` funcione con un rol de solo lectura) y
   `write` por tool de escritura. Con cookie, el CSRF también aplica a `POST /mcp`.
10. `resumen_humano` **solo en español** (es para la conversación). La página del módulo tendrá sus
    textos en `locales/`.

## Pendiente para el turno C

- UI del módulo (`modules/batteries`): `module.json` (`capabilities.api.prefix` y
  `capabilities.permissions.module`), `lib/api.js` (fetch same-origin, CSRF con reintento como
  cleaningplan, `ExtError` con `code`/`reason`), vista **Lugares** + hoja de stock + historial por
  lugar, `locales/es.json` + `en.json` con `menu`/`module`.
- **Paso 25**: test con grep que prohíba `innerHTML` interpolado (cuando exista la UI).
- `docker-compose.dev.yml` (Yuvomi local + módulo montado + sidecar): probar que Yuvomi recoge la
  carpeta copiada **sin reiniciar**, que `ext:batteries` aparece en el catálogo de permisos y, si se
  quiere el QR de v1.1, si `/m/batteries?lugar=` llega al módulo.
- Turno D: `hermes mcp test` con el MCP registrado en el perfil `default`; imagen, tienda, NPM.

---

# Turno A (Fases 0 y 1), 2026-11-23

Rama de trabajo de entonces: `feat/dominio`, mergeada en `main` (`ea120ae`) tras la revisión.

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
