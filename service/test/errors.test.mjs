import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, fromSqlite } from '../app/errors.mjs';
import { memoryDb } from './helpers.mjs';

test('a trigger abort and the identity index become 409 DomainErrors, anything else passes through', () => {
  const db = memoryDb();
  const now = '2026-11-23T18:00:00Z';
  db.prepare("INSERT INTO pools (kind, brand, total, created_at) VALUES ('AAA', 'Duracell', 1, ?)").run(now);
  const raw = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('expected a throw'); };

  const trig = fromSqlite(raw(() => db.prepare(
    "INSERT INTO allocations (pool_id, kind, label, slug, quantity, placed_on, created_at) VALUES (1, 'device', 'T', 't', 2, '2026-11-23', ?)",
  ).run(now)));
  assert.ok(trig instanceof DomainError);
  assert.deepEqual([trig.code, trig.reason], [409, 'stock_exceeded']);

  const dup = fromSqlite(raw(() => db.prepare(
    "INSERT INTO pools (kind, brand, total, created_at) VALUES ('aaa', ' DURACELL', 1, ?)",
  ).run(now)));
  assert.deepEqual([dup.code, dup.reason], [409, 'pool_exists']);

  const other = new Error('disk I/O error');
  assert.equal(fromSqlite(other), other);
  assert.deepEqual(new DomainError(409, 'x', 'msg', { a: 1 }).toJSON(), { error: 'msg', code: 409, reason: 'x', details: { a: 1 } });
});
