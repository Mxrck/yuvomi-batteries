import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, SCHEMA_VERSION } from '../app/db.mjs';
import { fileDb, memoryDb } from './helpers.mjs';

const NOW = '2026-11-23T18:00:00Z';

function insertPool(db, total) {
  return Number(db.prepare(
    "INSERT INTO pools (kind, brand, total, created_at) VALUES ('AAA', 'Duracell', ?, ?)",
  ).run(total, NOW).lastInsertRowid);
}

function insertPlace(db, poolId, kind, slug, quantity) {
  return Number(db.prepare(
    `INSERT INTO allocations (pool_id, kind, label, slug, quantity, placed_on, created_at)
     VALUES (?, ?, ?, ?, ?, '2026-11-23', ?)`,
  ).run(poolId, kind, slug, slug, quantity, NOW).lastInsertRowid);
}

test('migrations are idempotent, WAL and foreign keys are on', () => {
  const f = fileDb();
  try {
    const db1 = openDb(f.path);
    insertPool(db1, 5);
    db1.close();
    const db2 = openDb(f.path); // second open must not re-run migration 1 nor lose data
    assert.equal(db2.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(db2.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db2.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db2.prepare('SELECT count(*) AS c FROM pools').get().c, 1);
    db2.close();
  } finally {
    f.cleanup();
  }
});

test('schema has the indexes and the three invariant triggers', () => {
  const db = memoryDb();
  const names = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('index','trigger')").all()
    .map((r) => `${r.type}:${r.name}`);
  for (const n of [
    'index:pools_identity', 'index:one_missing_per_pool', 'index:by_pool_place',
    'trigger:trg_alloc_guard_ins', 'trigger:trg_alloc_guard_upd', 'trigger:trg_pool_total_guard',
  ]) assert.ok(names.includes(n), `missing ${n}`);
});

test('trigger aborts a direct insert that skips the code validation', () => {
  const db = memoryDb();
  const pool = insertPool(db, 4);
  insertPlace(db, pool, 'device', 'tren', 3);
  assert.throws(() => insertPlace(db, pool, 'device', 'control', 2), /stock_exceeded/);
  // Sin ubicar is not counted against the stock: it is derived from it.
  assert.doesNotThrow(() => insertPlace(db, pool, 'missing', 'sin-ubicar', 1));
});

test('trigger aborts an update that grows a place beyond the stock', () => {
  const db = memoryDb();
  const pool = insertPool(db, 4);
  const id = insertPlace(db, pool, 'device', 'tren', 3);
  assert.throws(() => db.prepare('UPDATE allocations SET quantity = 5 WHERE id = ?').run(id), /stock_exceeded/);
  assert.doesNotThrow(() => db.prepare('UPDATE allocations SET quantity = 4 WHERE id = ?').run(id));
});

test('trigger aborts lowering a pool total below what is placed', () => {
  const db = memoryDb();
  const pool = insertPool(db, 4);
  insertPlace(db, pool, 'device', 'tren', 3);
  assert.throws(() => db.prepare('UPDATE pools SET total = 2 WHERE id = ?').run(pool), /stock_exceeded/);
  assert.doesNotThrow(() => db.prepare('UPDATE pools SET total = 3 WHERE id = ?').run(pool));
});

test('pool identity ignores case, spaces and a NULL line or capacity', () => {
  const db = memoryDb();
  db.prepare("INSERT INTO pools (kind, brand, total, created_at) VALUES ('AAA', 'Duracell', 1, ?)").run(NOW);
  assert.throws(
    () => db.prepare("INSERT INTO pools (kind, brand, total, created_at) VALUES ('aaa', 'duracell ', 1, ?)").run(NOW),
    /UNIQUE/,
  );
  assert.doesNotThrow(() => db.prepare(
    "INSERT INTO pools (kind, brand, product_line, total, created_at) VALUES ('AAA', 'Duracell', 'Recharge', 1, ?)",
  ).run(NOW));
});

test('only one active Sin ubicar and one active row per pool and place', () => {
  const db = memoryDb();
  const pool = insertPool(db, 10);
  insertPlace(db, pool, 'missing', 'sin-ubicar', 2);
  assert.throws(() => insertPlace(db, pool, 'missing', 'sin-ubicar', 1), /UNIQUE/);
  insertPlace(db, pool, 'device', 'tren', 1);
  assert.throws(() => insertPlace(db, pool, 'device', 'tren', 1), /UNIQUE/);
});
