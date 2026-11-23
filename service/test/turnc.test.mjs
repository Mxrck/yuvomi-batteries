// Turn C additions to the sidecar: the channel (`via`) follows the transport, migration 2 lets
// movements say 'api', and the two reads the module page needs (/me, /labels).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, SCHEMA_VERSION } from '../app/db.mjs';
import { createPool, knownPlaces, moveTo, place } from '../app/places.mjs';
import { bearer, browser, call, PREFIX, startApp } from './http-helpers.mjs';
import { ctx, fileDb, memoryDb } from './helpers.mjs';

test('migration 2 keeps a v1 database and lets movements record via = api', () => {
  const g = fileDb();
  try {
    // Rebuild a database exactly as turn B left it: schema 1, movements with the old CHECK.
    const db1 = openDb(g.path);
    db1.exec('PRAGMA user_version = 1'); // pretend migration 2 never ran…
    db1.exec("DROP TABLE movements");      // …and put back the v1 shape of movements
    db1.exec("CREATE TABLE movements (id INTEGER PRIMARY KEY, pool_id INTEGER NOT NULL, allocation_id INTEGER, action TEXT NOT NULL, quantity INTEGER, from_label TEXT, to_label TEXT, from_slug TEXT, to_slug TEXT, detail TEXT, actor_user_id INTEGER, actor_name TEXT, via TEXT NOT NULL CHECK (via IN ('ui', 'mcp')), request_id TEXT, created_at TEXT NOT NULL)");
    db1.exec("INSERT INTO movements (pool_id, action, via, created_at) VALUES (1, 'pool_created', 'mcp', '2026-11-23T09:13:25Z')");
    assert.throws(() => db1.exec("INSERT INTO movements (pool_id, action, via, created_at) VALUES (1, 'x', 'api', 'now')"), /CHECK/);
    db1.close();

    const db2 = openDb(g.path);
    assert.equal(SCHEMA_VERSION, 2);
    assert.equal(db2.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(db2.prepare('SELECT count(*) AS c FROM movements').get().c, 1, 'existing rows kept');
    assert.doesNotThrow(() => db2.exec("INSERT INTO movements (pool_id, action, via, created_at) VALUES (1, 'x', 'api', 'now')"));
    assert.throws(() => db2.exec("INSERT INTO movements (pool_id, action, via, created_at) VALUES (1, 'x', 'cli', 'now')"), /CHECK/);
    const idx = db2.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'movements'").all().map((r) => r.name).sort();
    assert.deepEqual(idx, ['movements_from_slug', 'movements_to_slug']);
    db2.close();
  } finally {
    g.cleanup();
  }
});

test('via follows the transport: cookie → ui, Bearer REST → api, MCP → mcp', async () => {
  const app = await startApp();
  try {
    const created = await call(app.base, 'POST', `${PREFIX}/pools`, { headers: bearer('admin'), body: { kind: 'AAA', brand: 'Duracell', total: 10 } });
    const id = created.json.data.id;
    await call(app.base, 'POST', `${PREFIX}/places/place`, { headers: browser('writer'), body: { pool_id: id, label: 'Tren', quantity: 1 } });
    await call(app.base, 'POST', `${PREFIX}/mcp`, { headers: bearer('admin'), body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'poner', arguments: { lugar: 'Control', cantidad: 1 } } } });
    const rows = app.db.prepare('SELECT action, via, actor_name FROM movements ORDER BY id').all().map((r) => `${r.action}:${r.via}:${r.actor_name}`);
    assert.deepEqual(rows, ['pool_created:api:Marco', 'placed:ui:Yesenia', 'placed:mcp:Marco']);
  } finally {
    await app.close();
  }
});

test('GET /me tells the page who is calling and whether they may write', async () => {
  const app = await startApp();
  try {
    const me = await call(app.base, 'GET', `${PREFIX}/me`, { headers: browser('reader') });
    assert.equal(me.status, 200);
    assert.deepEqual(me.json.data, { user_id: 3, name: 'Ángel', access: 'read' });
    assert.equal((await call(app.base, 'GET', `${PREFIX}/me`, { headers: bearer('admin') })).json.data.access, 'write');
    // A member without the permission still learns that much (the page says "no access").
    const none = await call(app.base, 'GET', `${PREFIX}/me`, { headers: bearer('nobody') });
    assert.equal(none.status, 200);
    assert.equal(none.json.data.access, 'none');
    assert.equal((await call(app.base, 'GET', `${PREFIX}/me`)).status, 401);
    assert.equal((await call(app.base, 'GET', `${PREFIX}/me`, { headers: bearer('guest') })).status, 403);
  } finally {
    await app.close();
  }
});

test('knownPlaces / GET /labels: every place ever used, with kind and its last use', async () => {
  const db = memoryDb();
  const pool = createPool(db, { kind: 'AAA', brand: 'Duracell', total: 10 }, ctx());
  place(db, { pool_id: pool.id, label: 'Tren Thomas', quantity: 3 }, ctx());
  place(db, { pool_id: pool.id, label: 'Cargador', kind: 'charger', quantity: 2 }, ctx());
  moveTo(db, { from_slug: 'tren-thomas', to_label: 'Cargador' }, ctx());
  assert.deepEqual(knownPlaces(db), [
    { slug: 'cargador', label: 'Cargador', kind: 'charger', active: true, last: { pool_id: pool.id, quantity: 5 } },
    { slug: 'tren-thomas', label: 'Tren Thomas', kind: 'device', active: false, last: { pool_id: pool.id, quantity: 3 } },
  ]);

  const app = await startApp({ db });
  try {
    const r = await call(app.base, 'GET', `${PREFIX}/labels`, { headers: bearer('reader') });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.length, 2);
  } finally {
    await app.close();
  }
});
