// server.mjs over real HTTP with the /auth/me stand-in. Steps 20–24 of the plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, browser, call, ORIGIN, PREFIX, startApp } from './http-helpers.mjs';
import { count } from './helpers.mjs';

async function withApp(fn) {
  const app = await startApp();
  try { await fn(app); } finally { await app.close(); }
}

async function seed(app) {
  const r = await call(app.base, 'POST', `${PREFIX}/pools`, {
    headers: bearer('admin'), body: { kind: 'AAA', brand: 'Duracell', product_line: 'Recharge', total: 24 },
  });
  assert.equal(r.status, 201);
  return r.json.data.id;
}

test('/health answers without credentials and without internals', async () => withApp(async ({ base, yuvomi }) => {
  const r = await call(base, 'GET', `${PREFIX}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(yuvomi.calls.length, 0);
}));

test('20 · no credential → 401 with {error, code, reason}; foreign scope → 403', async () => withApp(async ({ base }) => {
  const r = await call(base, 'GET', `${PREFIX}/summary`);
  assert.equal(r.status, 401);
  assert.deepEqual({ code: r.json.code, reason: r.json.reason }, { code: 401, reason: 'not_authenticated' });
  assert.equal(typeof r.json.error, 'string');
  const g = await call(base, 'GET', `${PREFIX}/summary`, { headers: bearer('guest') });
  assert.equal(g.status, 403);
  assert.equal(g.json.reason, 'family_scope_required');
}));

test('22 · read can GET and not POST; none gets nothing; admin writes', async () => withApp(async (app) => {
  const poolId = await seed(app);
  assert.equal((await call(app.base, 'GET', `${PREFIX}/summary`, { headers: bearer('reader') })).status, 200);
  const post = await call(app.base, 'POST', `${PREFIX}/places/place`, { headers: bearer('reader'), body: { pool_id: poolId, label: 'Tren', quantity: 1 } });
  assert.equal(post.status, 403);
  assert.equal(post.json.reason, 'permission_required');
  assert.equal((await call(app.base, 'GET', `${PREFIX}/places`, { headers: bearer('nobody') })).status, 403);
  assert.equal((await call(app.base, 'POST', `${PREFIX}/places/place`, { headers: bearer('writer'), body: { pool_id: poolId, label: 'Tren', quantity: 1 } })).status, 200);
}));

test('23 · cookie + foreign Origin → csrf_invalid and nothing written; Bearer + foreign Origin → written', async () => withApp(async (app) => {
  const poolId = await seed(app);
  const body = { pool_id: poolId, label: 'Tren', quantity: 2 };
  const moves = count(app.db, 'movements');
  const bad = await call(app.base, 'POST', `${PREFIX}/places/place`, { headers: browser('writer', { origin: 'https://evil.test' }), body });
  assert.equal(bad.status, 403);
  assert.equal(bad.json.reason, 'csrf_invalid');
  assert.equal(count(app.db, 'movements'), moves);
  const good = await call(app.base, 'POST', `${PREFIX}/places/place`, { headers: browser('writer'), body });
  assert.equal(good.status, 200);
  const viaBearer = await call(app.base, 'POST', `${PREFIX}/places/place`, { headers: { ...bearer('writer'), origin: 'https://evil.test' }, body: { ...body, label: 'Control' } });
  assert.equal(viaBearer.status, 200);
}));

test('24 · every mutation route answers data + resumen_humano; domain errors keep code, reason and details', async () => withApp(async (app) => {
  const h = { headers: bearer('admin') };
  const created = await call(app.base, 'POST', `${PREFIX}/pools`, { ...h, body: { kind: 'AA', brand: 'Eneloop', total: 10 } });
  assert.equal(created.status, 201);
  const id = created.json.data.id;
  const steps = [
    ['POST', '/places/place', { pool_id: id, label: 'Cajón', kind: 'drawer', quantity: 6 }],
    ['POST', '/places/place', { pool_id: id, label: 'Control TV', quantity: 2 }],
    ['POST', '/places/change', { label: 'Control TV', old_to: 'charger' }],
    ['POST', '/places/move', { from_slug: 'cargador', to_label: 'Control A/C', quantity: 1 }],
    ['POST', '/places/find', { pool_id: id, quantity: 1, to_label: 'Sofá' }],
    ['POST', '/places/discard', { slug: 'sofa' }],
    ['PATCH', `/pools/${id}`, { total: 12 }],
    ['POST', `/pools/${id}/archive`, {}],
  ];
  for (const [method, path, body] of steps) {
    const r = await call(app.base, method, PREFIX + path, { ...h, body });
    assert.equal(r.status, 200, `${method} ${path}: ${r.text}`);
    assert.equal(typeof r.json.resumen_humano, 'string', path);
    assert.ok(r.json.resumen_humano.length > 5, path);
    assert.ok(r.json.data, path);
  }
  const dup = await call(app.base, 'POST', `${PREFIX}/pools`, { ...h, body: { kind: 'aa', brand: 'eneloop ', total: 1 } });
  assert.equal(dup.status, 201); // the archived one freed the identity
  const over = await call(app.base, 'POST', `${PREFIX}/places/place`, { ...h, body: { pool_id: dup.json.data.id, label: 'X', quantity: 5 } });
  assert.equal(over.status, 409);
  assert.equal(over.json.code, 409);
  assert.equal(over.json.reason, 'stock_exceeded');
  assert.deepEqual(over.json.details.breakdown, { device: 0, charger: 0, drawer: 0, missing: 1 });
}));

test('reads: summary (with archived), places, history, export', async () => withApp(async (app) => {
  const id = await seed(app);
  const h = { headers: bearer('reader') };
  await call(app.base, 'POST', `${PREFIX}/places/place`, { headers: bearer('admin'), body: { pool_id: id, label: 'Tren Thomas', quantity: 3 } });
  const places = await call(app.base, 'GET', `${PREFIX}/places?state=active`, h);
  assert.equal(places.json.data[0].slug, 'tren-thomas');
  assert.equal(places.json.data[0].items[0].age_days, 0);
  assert.equal((await call(app.base, 'GET', `${PREFIX}/places?include_missing=1`, h)).json.data.length, 2);
  const hist = await call(app.base, 'GET', `${PREFIX}/places/tren-thomas/history`, h);
  assert.deepEqual(hist.json.data.map((m) => m.action), ['placed']);
  await call(app.base, 'POST', `${PREFIX}/pools/${id}/archive`, { headers: bearer('admin'), body: {} });
  assert.equal((await call(app.base, 'GET', `${PREFIX}/summary`, h)).json.data.length, 0);
  assert.equal((await call(app.base, 'GET', `${PREFIX}/summary?include_archived=1`, h)).json.data.length, 1);
  const exp = await call(app.base, 'GET', `${PREFIX}/export`, h);
  assert.equal(exp.status, 200);
  assert.deepEqual(Object.keys(exp.json.data).sort(), ['allocations', 'exported_at', 'movements', 'pools', 'schema_version']);
  assert.equal(exp.json.data.pools.length, 1);
  assert.equal(exp.json.data.requests, undefined);
}));

test('HTTP hygiene: unknown routes, wrong method, bad JSON, wrong content type, oversize body', async () => withApp(async (app) => {
  const h = bearer('admin');
  assert.equal((await call(app.base, 'GET', `${PREFIX}/nope`, { headers: h })).json.reason, 'not_found');
  assert.equal((await call(app.base, 'GET', '/other', { headers: h })).status, 404);
  const wrong = await call(app.base, 'DELETE', `${PREFIX}/summary`, { headers: h });
  assert.equal(wrong.status, 405);
  assert.equal((await call(app.base, 'POST', `${PREFIX}/pools`, { headers: h, body: '{nope' })).json.reason, 'invalid_json');
  assert.equal((await call(app.base, 'POST', `${PREFIX}/pools`, { headers: { ...h, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  const big = await call(app.base, 'POST', `${PREFIX}/pools`, { headers: h, body: JSON.stringify({ notes: 'x'.repeat(70_000) }) });
  assert.equal(big.status, 413);
  // Unauthenticated callers learn nothing about routes: 401 before 404.
  assert.equal((await call(app.base, 'GET', `${PREFIX}/nope`)).status, 401);
}));

test('PUBLIC_ORIGIN is the only accepted Origin for cookie writes even with a trailing slash in config', async () => {
  assert.equal(new URL(`${ORIGIN}/`).origin, ORIGIN);
});
