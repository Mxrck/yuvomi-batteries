// MCP over Streamable HTTP (JSON responses). Steps 26–28 of the plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, call, PREFIX, startApp } from './http-helpers.mjs';
import { count } from './helpers.mjs';

const MCP = `${PREFIX}/mcp`;
let nextId = 1;
const rpc = (method, params) => ({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) });
const tool = (name, args = {}) => rpc('tools/call', { name, arguments: args });
const parse = (r) => JSON.parse(r.json.result.content[0].text);

async function withApp(fn) {
  const app = await startApp();
  try { await fn(app); } finally { await app.close(); }
}
const post = (app, body, who = 'admin') => call(app.base, 'POST', MCP, {
  headers: { ...bearer(who), accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body,
});

test('26 · initialize negotiates the version; initialized is 202; tools/list has the 8 intent tools', async () => withApp(async (app) => {
  const init = await post(app, rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } }));
  assert.equal(init.status, 200);
  assert.match(init.headers['content-type'], /^application\/json/);
  assert.equal(init.json.result.protocolVersion, '2025-11-25');
  assert.ok(init.json.result.capabilities.tools);
  assert.equal(init.json.result.serverInfo.name, 'yuvomi-batteries');
  const old = await post(app, rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }));
  assert.equal(old.json.result.protocolVersion, '2025-03-26');
  const future = await post(app, rpc('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 't', version: '0' } }));
  assert.equal(future.json.result.protocolVersion, '2025-11-25');

  const note = await post(app, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  assert.equal(note.text, '');

  const list = await post(app, rpc('tools/list'));
  const names = list.json.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['agregar_stock', 'cambiar_pilas', 'desechar', 'donde_estan', 'encontrar', 'mover', 'poner', 'resumen']);
  for (const t of list.json.result.tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description.length > 20, t.name);
  }
  const ping = await post(app, rpc('ping'));
  assert.deepEqual(ping.json.result, {});
}));

test('26 · invalid Bearer → 401 at HTTP level; GET on /mcp → 405; unknown method → -32601', async () => withApp(async (app) => {
  const bad = await post(app, rpc('tools/list'), 'stale-token');
  assert.equal(bad.status, 401);
  assert.equal(bad.json.reason, 'not_authenticated');
  const get = await call(app.base, 'GET', MCP, { headers: bearer('admin') });
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST');
  const unknown = await post(app, rpc('resources/list'));
  assert.equal(unknown.json.error.code, -32601);
  const garbage = await post(app, { hello: 1 });
  assert.equal(garbage.json.error.code, -32600);
}));

test('the agent flow: agregar_stock, poner, cambiar_pilas, mover, encontrar, desechar, donde_estan, resumen', async () => withApp(async (app) => {
  let r = parse(await post(app, tool('agregar_stock', { tipo: 'AAA', marca: 'Duracell', linea: 'Recharge', delta: 24 })));
  assert.equal(r.resumen_humano, 'Nuevo stock AAA Duracell Recharge: 24 (24 sin ubicar)');
  parse(await post(app, tool('poner', { lugar: 'Cajón', clase_lugar: 'cajon', cantidad: 6 })));
  r = parse(await post(app, tool('poner', { lugar: 'Tren Percy', cantidad: 3 })));
  assert.equal(r.resumen_humano, 'Tren Percy: 3 AAA Duracell Recharge (desde Cajón)');
  r = parse(await post(app, tool('cambiar_pilas', { lugar: 'el tren de percy' })));
  assert.equal(r.resumen_humano, 'Tren Percy: 3 AAA Duracell Recharge nuevas; las viejas → Cargador');
  r = parse(await post(app, tool('mover', { desde: 'cargador', hacia: 'Control minisplit', cantidad: 2 })));
  assert.equal(r.resumen_humano, '2 AAA Duracell Recharge: Cargador → Control minisplit');
  r = parse(await post(app, tool('encontrar', { tipo: 'AAA', cantidad: 3, lugar: 'Sofá' })));
  assert.equal(r.resumen_humano, 'Encontradas 3 AAA Duracell Recharge en Sofá; quedan 15 sin ubicar');
  r = parse(await post(app, tool('desechar', { lugar: 'control minisplit', cantidad: 1 })));
  assert.equal(r.resumen_humano, 'Desechadas 1 AAA Duracell Recharge de Control minisplit; el total queda en 23');
  r = parse(await post(app, tool('agregar_stock', { tipo: 'AAA', marca: 'duracell', linea: 'recharge', delta: 1 })));
  assert.equal(r.resumen_humano, 'AAA Duracell Recharge: total 24 (16 sin ubicar)');
  r = parse(await post(app, tool('donde_estan', { lugar: 'tren percy' })));
  assert.equal(r.resumen_humano, 'Tren Percy: 3 AAA Duracell Recharge, puestas hoy');
  r = parse(await post(app, tool('donde_estan', { tipo: 'AAA' })));
  // The drawer emptied during the change, so it is not a place any more.
  assert.deepEqual(r.data.map((c) => c.slug).sort(), ['cargador', 'control-minisplit', 'sofa', 'tren-percy']);
  r = parse(await post(app, tool('resumen')));
  assert.equal(r.resumen_humano, 'AAA Duracell Recharge: 24 = 7 en aparatos · 1 en cargador · 0 en cajón · 16 sin ubicar');
  // Every movement of the flow is recorded as via mcp, with the identity from /auth/me.
  const vias = app.db.prepare('SELECT DISTINCT via, actor_name FROM movements').all().map((m) => `${m.via}:${m.actor_name}`);
  assert.deepEqual(vias, ['mcp:Marco']);
}));

test('implicit template: without quantity or pool, the last use of the place decides', async () => withApp(async (app) => {
  parse(await post(app, tool('agregar_stock', { tipo: 'AAA', marca: 'Duracell', delta: 10 })));
  parse(await post(app, tool('agregar_stock', { tipo: 'AAA', marca: 'Amazon', delta: 10 })));
  parse(await post(app, tool('poner', { lugar: 'Tren Thomas', marca: 'Amazon', cantidad: 3 })));
  parse(await post(app, tool('mover', { desde: 'tren thomas', hacia: 'Cargador', clase_lugar: 'cargador' })));
  const r = parse(await post(app, tool('poner', { lugar: 'Tren Thomas', desde: 'cargador' })));
  assert.equal(r.resumen_humano, 'Tren Thomas: 3 AAA Amazon (desde Cargador)');
}));

test('28 · an ambiguous place returns candidates as a tool error and writes nothing', async () => withApp(async (app) => {
  parse(await post(app, tool('agregar_stock', { tipo: 'AAA', marca: 'Duracell', delta: 12 })));
  parse(await post(app, tool('poner', { lugar: 'Cajón', clase_lugar: 'cajon', cantidad: 6 })));
  parse(await post(app, tool('poner', { lugar: 'Tren Thomas', cantidad: 3 })));
  parse(await post(app, tool('poner', { lugar: 'Tren Percy', cantidad: 3 })));
  const before = { a: count(app.db, 'allocations'), m: count(app.db, 'movements') };
  const r = await post(app, tool('cambiar_pilas', { lugar: 'el tren' }));
  assert.equal(r.status, 200);
  assert.equal(r.json.result.isError, true);
  const body = parse(r);
  assert.equal(body.reason, 'ambiguous_target');
  assert.deepEqual(body.details.candidates.map((c) => c.slug).sort(), ['tren-percy', 'tren-thomas']);
  assert.equal(count(app.db, 'allocations'), before.a);
  assert.equal(count(app.db, 'movements'), before.m);
  // An ambiguous pool too: two AAA pools and no hint.
  parse(await post(app, tool('agregar_stock', { tipo: 'AAA', marca: 'Amazon', delta: 4 })));
  const pool = await post(app, tool('encontrar', { tipo: 'AAA', cantidad: 1, lugar: 'Sofá' }));
  assert.equal(parse(pool).reason, 'ambiguous_target');
}));

test('permissions and idempotency through MCP', async () => withApp(async (app) => {
  const denied = await post(app, tool('agregar_stock', { tipo: 'AA', marca: 'X', delta: 1 }), 'reader');
  assert.equal(denied.json.result.isError, true);
  assert.equal(parse(denied).reason, 'permission_required');
  assert.equal((await post(app, tool('resumen'), 'reader')).json.result.isError, undefined);
  const args = { tipo: 'AA', marca: 'Eneloop', delta: 8, request_id: 'tg-123' };
  const a = parse(await post(app, tool('agregar_stock', args)));
  const b = parse(await post(app, tool('agregar_stock', args)));
  assert.deepEqual(b, a);
  assert.equal(app.db.prepare('SELECT total FROM pools').get().total, 8);
  const bad = parse(await post(app, tool('agregar_stock', { ...args, delta: 9 })));
  assert.equal(bad.reason, 'request_id_reused');
  const unknown = await post(app, tool('borrar_todo'));
  assert.equal(unknown.json.error.code, -32602);
}));
