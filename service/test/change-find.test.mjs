// "Cambiar pilas" (atomic swap) and "encontrar" (out of Sin ubicar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { change, createPool, find, moveTo, place, summary } from '../app/places.mjs';
import { activeRows, catchDomain, count, ctx, memoryDb, placedSum } from './helpers.mjs';

// 24 AAA: tren 3, cajón 6, cargador 2, 13 sin ubicar.
function house(db) {
  const pool = createPool(db, { kind: 'AAA', brand: 'Duracell', product_line: 'Recharge', total: 24 }, ctx());
  place(db, { pool_id: pool.id, label: 'Tren Percy', quantity: 3 }, ctx());
  place(db, { pool_id: pool.id, label: 'Cajón', kind: 'drawer', quantity: 6 }, ctx());
  place(db, { pool_id: pool.id, label: 'Cargador', kind: 'charger', quantity: 2 }, ctx());
  return pool;
}

const byKind = (db) => summary(db)[0].breakdown;

test('11 · change: old ones to the charger, new ones from the drawer, one transaction', () => {
  const db = memoryDb();
  const pool = house(db);
  const res = change(db, { label: 'tren percy', old_to: 'charger' }, ctx({ now: new Date('2026-11-30T18:00:00Z') }));
  assert.deepEqual(byKind(db), { device: 3, charger: 5, drawer: 3, missing: 13 });
  assert.deepEqual(res.legs.map((l) => [l.role, l.from.slug, l.to.slug, l.quantity]), [
    ['old', 'tren-percy', 'cargador', 3],
    ['new', 'cajon', 'tren-percy', 3],
  ]);
  // The device row is a new one, dated today; the old one is closed as moved.
  const rows = db.prepare("SELECT quantity, placed_on, closed_reason FROM allocations WHERE slug = 'tren-percy' ORDER BY id").all();
  assert.deepEqual(rows.map((r) => [r.quantity, r.placed_on, r.closed_reason]), [[3, '2026-11-23', 'moved'], [3, '2026-11-30', null]]);
  assert.equal(placedSum(db, pool.id), 24);
});

test('11 · change with too few in the drawer is insufficient_drawer and changes nothing', () => {
  const db = memoryDb();
  const pool = house(db);
  moveTo(db, { from_slug: 'cajon', to_label: 'Control TV', quantity: 5 }, ctx()); // drawer keeps 1
  const before = { rows: activeRows(db, pool.id), a: count(db, 'allocations'), m: count(db, 'movements') };
  const err = catchDomain(() => change(db, { label: 'Tren Percy', old_to: 'charger' }, ctx()));
  assert.equal(err.reason, 'insufficient_drawer');
  assert.equal(err.code, 409);
  assert.deepEqual(err.details, { pool_id: pool.id, needed: 3, available: 1 });
  assert.deepEqual(activeRows(db, pool.id), before.rows);
  assert.equal(count(db, 'allocations'), before.a);
  assert.equal(count(db, 'movements'), before.m);
});

test('11b · change with old ones to the trash lowers the total', () => {
  const db = memoryDb();
  house(db);
  change(db, { label: 'Tren Percy', old_to: 'trash' }, ctx());
  const [p] = summary(db);
  assert.equal(p.total, 21);
  assert.deepEqual(p.breakdown, { device: 3, charger: 2, drawer: 3, missing: 13 });
});

test('11c · change with old ones to the drawer: the drawer still has to cover the new ones first', () => {
  const db = memoryDb();
  house(db);
  change(db, { label: 'Tren Percy', old_to: 'drawer' }, ctx());
  assert.deepEqual(byKind(db), { device: 3, charger: 2, drawer: 6, missing: 13 });
});

test('11d · change can switch to another pool and quantity', () => {
  const db = memoryDb();
  house(db);
  const eneloop = createPool(db, { kind: 'AAA', brand: 'Panasonic', product_line: 'Eneloop', total: 8 }, ctx());
  place(db, { pool_id: eneloop.id, label: 'Cajón', quantity: 8 }, ctx()); // existing drawer slug keeps its kind
  change(db, { label: 'Tren Percy', old_to: 'charger', new_pool_id: eneloop.id, new_quantity: 2 }, ctx());
  const [duracell, panasonic] = summary(db);
  assert.deepEqual(duracell.breakdown, { device: 0, charger: 5, drawer: 6, missing: 13 });
  assert.deepEqual(panasonic.breakdown, { device: 2, charger: 0, drawer: 6, missing: 0 });
});

test('11e · change on a place with two pools refuses a single new pool/quantity as ambiguous', () => {
  const db = memoryDb();
  const pool = house(db);
  const other = createPool(db, { kind: 'AAA', brand: 'Amazon Basics', total: 4 }, ctx());
  place(db, { pool_id: other.id, label: 'Tren Percy', quantity: 1 }, ctx());
  place(db, { pool_id: other.id, label: 'Cajón', quantity: 3 }, ctx());
  const err = catchDomain(() => change(db, { label: 'Tren Percy', old_to: 'charger', new_quantity: 3 }, ctx()));
  assert.equal(err.reason, 'ambiguous_target');
  assert.deepEqual(err.details.candidates.map((c) => c.pool_id).sort(), [pool.id, other.id].sort());
  // Without overrides each pool is replaced like for like.
  const res = change(db, { label: 'Tren Percy', old_to: 'charger' }, ctx());
  assert.equal(res.legs.length, 4);
});

test('11f · change creates the charger when the house has none, and refuses to guess between two', () => {
  const db = memoryDb();
  const pool = createPool(db, { kind: 'AA', brand: 'Eneloop', total: 10 }, ctx());
  place(db, { pool_id: pool.id, label: 'Control TV', quantity: 2 }, ctx());
  place(db, { pool_id: pool.id, label: 'Cajón', kind: 'drawer', quantity: 4 }, ctx());
  change(db, { label: 'Control TV', old_to: 'charger' }, ctx());
  assert.ok(activeRows(db, pool.id).some((r) => r.kind === 'charger' && r.label === 'Cargador'));
  place(db, { pool_id: pool.id, label: 'Cargador cocina', kind: 'charger', quantity: 1, from_slug: 'sin-ubicar' }, ctx());
  const err = catchDomain(() => change(db, { label: 'Control TV', old_to: 'charger' }, ctx()));
  assert.equal(err.reason, 'ambiguous_target');
  assert.deepEqual(err.details.candidates.map((c) => c.slug).sort(), ['cargador', 'cargador-cocina']);
});

test('11g · change only applies to devices, and needs an existing active place', () => {
  const db = memoryDb();
  house(db);
  assert.equal(catchDomain(() => change(db, { label: 'Cargador', old_to: 'drawer' }, ctx())).reason, 'invalid_input');
  assert.equal(catchDomain(() => change(db, { label: 'Nada', old_to: 'drawer' }, ctx())).reason, 'place_not_found');
  assert.equal(catchDomain(() => change(db, { label: 'Tren Percy', old_to: 'sofa' }, ctx())).reason, 'invalid_input');
});

test('12 · find moves out of Sin ubicar and lowers its count', () => {
  const db = memoryDb();
  const pool = house(db);
  const res = find(db, { pool_id: pool.id, quantity: 3, to_label: 'Cajón del escritorio', kind: 'drawer' }, ctx());
  assert.equal(res.legs[0].from.slug, 'sin-ubicar');
  assert.deepEqual(byKind(db), { device: 3, charger: 2, drawer: 9, missing: 10 });
  const m = db.prepare("SELECT action FROM movements ORDER BY id DESC LIMIT 1").get();
  assert.equal(m.action, 'found');
});

test('12b · finding more than Sin ubicar holds is stock_exceeded; finding the last ones closes it', () => {
  const db = memoryDb();
  const pool = house(db);
  assert.equal(catchDomain(() => find(db, { pool_id: pool.id, quantity: 14, to_label: 'Sofá' }, ctx())).reason, 'stock_exceeded');
  find(db, { pool_id: pool.id, quantity: 13, to_label: 'Sofá' }, ctx());
  assert.equal(activeRows(db, pool.id).some((r) => r.kind === 'missing'), false);
  assert.equal(byKind(db).missing, 0);
  assert.equal(placedSum(db, pool.id), 24);
});
