// Shared test helpers: a fresh database per test and small readers over raw tables.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../app/db.mjs';

export function memoryDb() {
  return openDb(':memory:');
}

// A real file, for what ':memory:' cannot show (WAL, reopening the same database).
export function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), 'batteries-test-'));
  const path = join(dir, 'batteries.db');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Fixed instant: 2026-11-23 12:00 in America/Merida (UTC-6, no DST).
export const NOON = new Date('2026-11-23T18:00:00Z');

export function ctx(extra = {}) {
  return { actorUserId: 1, actorName: 'Marco', via: 'ui', now: NOON, ...extra };
}

export function count(db, table) {
  return db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
}

export function activeRows(db, poolId) {
  return db.prepare(
    'SELECT kind, slug, label, quantity FROM allocations WHERE pool_id = ? AND closed_on IS NULL ORDER BY id',
  ).all(poolId).map((r) => ({ ...r }));
}

// Σ of every active place, Sin ubicar included: must equal the pool total, always.
export function placedSum(db, poolId) {
  return db.prepare(
    'SELECT IFNULL(SUM(quantity), 0) AS s FROM allocations WHERE pool_id = ? AND closed_on IS NULL',
  ).get(poolId).s;
}

export function poolTotal(db, poolId) {
  return db.prepare('SELECT total FROM pools WHERE id = ?').get(poolId).total;
}

// Runs fn and returns the DomainError it throws, failing the test when it does not throw.
export function catchDomain(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a DomainError, nothing was thrown');
}
