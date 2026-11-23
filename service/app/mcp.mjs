// MCP over Streamable HTTP, minimal: JSON responses only (no SSE stream, no sessions), the
// legacy initialize handshake, ping, tools/list and tools/call. Authentication is the same as
// the REST API (server.mjs resolves the caller before this runs).
//
// The tools are a thin facade over places.mjs: they map Spanish argument names to domain inputs,
// resolve free-text names through the domain's resolvers, and wrap every mutation in
// runIdempotent so resolution + write is one transaction under one request_id. No rule lives here.
import {
  change, discard, find, lastUse, matchPools, moveTo, place, placesList, receiveStock, resolveDestination,
  resolvePlace, resolvePool, runIdempotent, summary,
} from './places.mjs';
import { DomainError } from './errors.mjs';
import { humanize, placeLine, poolLine } from './humanize.mjs';

// Revisions of the legacy handshake this server speaks, newest first.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const KIND = { aparato: 'device', cargador: 'charger', cajon: 'drawer' };
const OLD_TO = { cargador: 'charger', cajon: 'drawer', basura: 'trash' };

const str = (description) => ({ type: 'string', description });
const int = (description, minimum = 1) => ({ type: 'integer', minimum, description });
const REQUEST_ID = str('Opcional. Identificador único de esta petición (p. ej. el id del mensaje). Si se repite con los mismos argumentos devuelve el mismo resultado sin volver a escribir.');
const CLASE = { type: 'string', enum: Object.keys(KIND), description: 'Solo para un lugar nuevo: aparato (por defecto), cargador o cajon.' };
const POOL_FILTERS = {
  tipo: str('Tamaño: AA, AAA, C, D, 9V, CR2032…'),
  marca: str('Marca, p. ej. Duracell, Eneloop.'),
  linea: str('Línea del producto, p. ej. Recharge, Max, Lithium.'),
};

const READ = new Set(['resumen', 'donde_estan']);

export const TOOLS = [
  {
    name: 'resumen',
    description: 'Resumen del stock de pilas: por cada tipo/marca/línea, cuántas hay en aparatos, en el cargador, en el cajón y sin ubicar. Úsala para "¿cómo vamos de pilas?".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'donde_estan',
    description: 'Dónde están las pilas: lo que tiene un lugar ("¿qué tiene el control del minisplit?") o todos los lugares con un tipo ("¿dónde hay AAA?"). Sin argumentos lista todos los lugares.',
    inputSchema: { type: 'object', properties: { lugar: str('Nombre del lugar, aunque sea aproximado.'), ...POOL_FILTERS }, additionalProperties: false },
  },
  {
    name: 'poner',
    description: 'Poner pilas en un lugar: "puse 2 AAA en el control de la sala". En un aparato salen del cajón (si hay) o de Sin ubicar. Si no se dice cantidad o tipo, se usa lo que ese lugar tuvo la última vez. Repite al usuario el resumen_humano de la respuesta.',
    inputSchema: {
      type: 'object',
      properties: {
        lugar: str('Lugar destino. Usa el nombre exacto de un lugar existente (donde_estan los lista) o uno nuevo.'),
        cantidad: int('Cuántas pilas.'),
        ...POOL_FILTERS,
        desde: str('Opcional: de dónde salieron (p. ej. "cargador", "sin ubicar").'),
        clase_lugar: CLASE,
        fecha: str('Opcional: fecha en que se pusieron, YYYY-MM-DD (por defecto hoy).'),
        request_id: REQUEST_ID,
      },
      required: ['lugar'],
      additionalProperties: false,
    },
  },
  {
    name: 'mover',
    description: 'Mover pilas de un lugar a otro: "las 3 del tren pasaron al cargador". Sin cantidad mueve todas las del lugar. Mover a "sin ubicar" es perderlas (no las desecha).',
    inputSchema: {
      type: 'object',
      properties: {
        desde: str('Lugar de origen, aunque sea aproximado.'),
        hacia: str('Lugar destino: nombre exacto, "cargador", "cajón", "sin ubicar" o uno nuevo.'),
        cantidad: int('Opcional: cuántas (por defecto todas).'),
        ...POOL_FILTERS,
        clase_lugar: CLASE,
        request_id: REQUEST_ID,
      },
      required: ['desde', 'hacia'],
      additionalProperties: false,
    },
  },
  {
    name: 'cambiar_pilas',
    description: 'Cambiar las pilas de un aparato, en un solo paso: las viejas van al cargador (por defecto), al cajón o a la basura, y salen nuevas del cajón en la misma cantidad. "Cambié las pilas del tren de Percy".',
    inputSchema: {
      type: 'object',
      properties: {
        lugar: str('El aparato, aunque sea aproximado.'),
        viejas_a: { type: 'string', enum: Object.keys(OLD_TO), description: 'A dónde van las viejas (por defecto cargador).' },
        cantidad_nueva: int('Opcional: cuántas nuevas, si no son las mismas.'),
        request_id: REQUEST_ID,
      },
      required: ['lugar'],
      additionalProperties: false,
    },
  },
  {
    name: 'encontrar',
    description: 'Registrar pilas que aparecieron: "encontré 3 AAA en el cajón del escritorio". Salen de Sin ubicar.',
    inputSchema: {
      type: 'object',
      properties: {
        cantidad: int('Cuántas aparecieron.'),
        lugar: str('Dónde aparecieron.'),
        ...POOL_FILTERS,
        clase_lugar: CLASE,
        fecha: str('Opcional: YYYY-MM-DD.'),
        request_id: REQUEST_ID,
      },
      required: ['cantidad', 'lugar'],
      additionalProperties: false,
    },
  },
  {
    name: 'desechar',
    description: 'Desechar pilas muertas: "tiré las 2 del control, ya no cargan". Baja el total. No la uses para pilas perdidas (eso es mover a "sin ubicar").',
    inputSchema: {
      type: 'object',
      properties: {
        lugar: str('Lugar donde estaban.'),
        cantidad: int('Opcional: cuántas (por defecto todas las del lugar).'),
        ...POOL_FILTERS,
        request_id: REQUEST_ID,
      },
      required: ['lugar'],
      additionalProperties: false,
    },
  },
  {
    name: 'agregar_stock',
    description: 'Agregar pilas compradas: "compré 12 AA Eneloop". Suma al stock que coincida o lo crea; las nuevas quedan en Sin ubicar hasta que se pongan en algún lugar.',
    inputSchema: {
      type: 'object',
      properties: {
        tipo: str('Tamaño: AA, AAA…'),
        marca: str('Marca.'),
        linea: str('Opcional: línea del producto.'),
        capacidad_mah: int('Opcional: capacidad en mAh.'),
        delta: int('Cuántas se agregan.'),
        request_id: REQUEST_ID,
      },
      required: ['tipo', 'marca', 'delta'],
      additionalProperties: false,
    },
  },
];

const filters = (a) => ({ tipo: a.tipo, marca: a.marca, linea: a.linea });
const hasFilters = (a) => Boolean(a.tipo || a.marca || a.linea);
const clase = (a) => (a.clase_lugar === undefined ? undefined : KIND[a.clase_lugar] ?? a.clase_lugar);

function invalid(message) {
  return new DomainError(400, 'invalid_input', message);
}

// Each handler returns { operation, result } (mutations) or { resumen_humano, data } (reads).
const HANDLERS = {
  resumen(db) {
    const pools = summary(db);
    return { resumen_humano: pools.length ? pools.map(poolLine).join('\n') : 'No hay stock de pilas registrado.', data: pools };
  },

  donde_estan(db, a, ctx) {
    let cards = placesList(db, { now: ctx.now, include_missing: a.lugar !== undefined });
    if (a.lugar !== undefined) {
      let slugs;
      try {
        slugs = [resolvePlace(db, a.lugar).slug];
      } catch (err) {
        // A question may list every match; only writes refuse to pick.
        if (!(err instanceof DomainError) || err.reason !== 'ambiguous_target') throw err;
        slugs = err.details.candidates.map((c) => c.slug);
      }
      cards = cards.filter((c) => slugs.includes(c.slug));
    }
    if (hasFilters(a)) {
      const ids = new Set(matchPools(db, filters(a)).map((p) => p.id));
      cards = cards.map((c) => ({ ...c, items: c.items.filter((i) => ids.has(i.pool_id)) })).filter((c) => c.items.length);
    }
    return { resumen_humano: cards.length ? cards.map(placeLine).join('\n') : 'No hay pilas registradas ahí.', data: cards };
  },

  poner(db, a, ctx) {
    return runIdempotent(db, 'mcp:poner', a, ctx, (args, c) => {
      const dest = resolveDestination(db, args.lugar);
      if (dest.kind === 'missing') throw invalid('Para perder pilas usa mover hacia "sin ubicar".');
      const pool = resolvePool(db, { ...filters(args), hintSlug: dest.slug });
      const hint = lastUse(db, dest.slug);
      const quantity = args.cantidad ?? (hint && hint.pool_id === pool.id ? hint.quantity : undefined);
      if (quantity === undefined) throw invalid('Falta la cantidad: ese lugar no tiene un uso anterior de esas pilas.');
      const from = args.desde === undefined ? undefined : resolvePlace(db, args.desde).slug;
      return { operation: 'place', result: place(db, { pool_id: pool.id, label: dest.label, kind: clase(args), quantity, from_slug: from, placed_on: args.fecha }, c) };
    });
  },

  mover(db, a, ctx) {
    return runIdempotent(db, 'mcp:mover', a, ctx, (args, c) => {
      const src = resolvePlace(db, args.desde);
      const dest = resolveDestination(db, args.hacia);
      let poolId;
      if (hasFilters(args) || src.kind === 'missing') poolId = resolvePool(db, { ...filters(args), hintSlug: dest.slug }).id;
      return { operation: 'move', result: moveTo(db, { from_slug: src.slug, to_label: dest.label, quantity: args.cantidad, kind: clase(args), pool_id: poolId }, c) };
    });
  },

  cambiar_pilas(db, a, ctx) {
    return runIdempotent(db, 'mcp:cambiar_pilas', a, ctx, (args, c) => {
      const at = resolvePlace(db, args.lugar);
      const oldTo = OLD_TO[args.viejas_a ?? 'cargador'];
      if (!oldTo) throw invalid('viejas_a debe ser cargador, cajon o basura.');
      return { operation: 'change', result: change(db, { slug: at.slug, old_to: oldTo, new_quantity: args.cantidad_nueva }, c) };
    });
  },

  encontrar(db, a, ctx) {
    return runIdempotent(db, 'mcp:encontrar', a, ctx, (args, c) => {
      const dest = resolveDestination(db, args.lugar);
      const pool = resolvePool(db, { ...filters(args), hintSlug: dest.slug });
      return { operation: 'find', result: find(db, { pool_id: pool.id, quantity: args.cantidad, to_label: dest.label, kind: clase(args), placed_on: args.fecha }, c) };
    });
  },

  desechar(db, a, ctx) {
    return runIdempotent(db, 'mcp:desechar', a, ctx, (args, c) => {
      const at = resolvePlace(db, args.lugar);
      let poolId;
      if (hasFilters(args) || at.kind === 'missing') poolId = resolvePool(db, filters(args)).id;
      return { operation: 'discard', result: discard(db, { slug: at.slug, quantity: args.cantidad, pool_id: poolId }, c) };
    });
  },

  agregar_stock(db, a, ctx) {
    return runIdempotent(db, 'mcp:agregar_stock', a, ctx, (args, c) => ({
      operation: 'receiveStock',
      result: receiveStock(db, { kind: args.tipo, brand: args.marca, product_line: args.linea, capacity_mah: args.capacidad_mah, delta: args.delta }, c),
    }));
  },
};

function toolResult(payload, isError = false) {
  const out = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  if (isError) out.isError = true;
  return out;
}

function callTool(db, identity, auth, params, now) {
  const name = params?.name;
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null;
  if (!handler) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  const args = params.arguments ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) return { error: { code: -32602, message: 'arguments must be an object' } };
  const ctx = { actorUserId: identity.userId, actorName: identity.name, via: 'mcp', now: now() };
  try {
    auth.authorize(identity, READ.has(name) ? 'read' : 'write');
    const out = handler(db, args, ctx);
    if (out.operation) return { result: toolResult({ resumen_humano: humanize(out.operation, out.result), data: out.result }) };
    return { result: toolResult(out) };
  } catch (err) {
    if (err instanceof DomainError) return { result: toolResult(err.toJSON(), true) };
    throw err;
  }
}

// One JSON-RPC message → a response object, or null for a notification.
function handleMessage(db, identity, auth, msg, { version, now }) {
  const isRequest = msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && typeof msg.method === 'string';
  if (!isRequest) return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  if (msg.id === undefined || msg.id === null) return null; // notification: nothing to answer
  const reply = (body) => ({ jsonrpc: '2.0', id: msg.id, ...body });
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'yuvomi-batteries', version },
          instructions: 'Pilas recargables de la casa: dónde está cada una. Toda escritura devuelve resumen_humano: repítelo al usuario. Si una tool responde ambiguous_target, pregunta cuál de los candidatos; nunca elijas.',
        },
      });
    }
    case 'ping':
      return reply({ result: {} });
    case 'tools/list':
      return reply({ result: { tools: TOOLS } });
    case 'tools/call':
      return reply(callTool(db, identity, auth, msg.params, now));
    default:
      return reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}

// body: parsed JSON (object or batch array). Returns { status, body } for server.mjs to send.
export function handleMcp(db, identity, auth, body, { version = '0.0.0', now = () => new Date() } = {}) {
  const opts = { version, now };
  if (Array.isArray(body)) {
    if (body.length === 0) return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Empty batch' } } };
    const out = body.map((m) => handleMessage(db, identity, auth, m, opts)).filter(Boolean);
    return out.length ? { status: 200, body: out } : { status: 202, body: null };
  }
  const out = handleMessage(db, identity, auth, body, opts);
  return out ? { status: 200, body: out } : { status: 202, body: null };
}
