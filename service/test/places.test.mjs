// Domain of places: pools, Sin ubicar, place, move, discard, archive, history.
// Numbers in the test names refer to the Fase 1 steps of the v3 plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archivePool, createPool, discard, moveTo, place, placeHistory, placesList, summary, updatePool,
} from '../app/places.mjs';
import { activeRows, catchDomain, count, ctx, memoryDb, placedSum, poolTotal } from './helpers.mjs';

function aaa(db, total = 24, extra = {}) {
  return createPool(db, { kind: 'AAA', brand: 'Duracell', product_line: 'Recharge', total, ...extra }, ctx());
}

test('5 · creating a pool creates Sin ubicar with the whole total', () => {
  const db = memoryDb();
  const pool = aaa(db);
  assert.equal(pool.name, 'AAA Duracell Recharge');
  assert.deepEqual(pool.breakdown, { device: 0, charger: 0, drawer: 0, missing: 24 });
  assert.deepEqual(activeRows(db, pool.id), [{ kind: 'missing', slug: 'sin-ubicar', label: 'Sin ubicar', quantity: 24 }]);
});

test('5b · a pool created with total 0 has no Sin ubicar row', () => {
  const db = memoryDb();
  const pool = aaa(db, 0);
  assert.equal(activeRows(db, pool.id).length, 0);
  assert.equal(pool.breakdown.missing, 0);
});

test('6 · place takes from Sin ubicar when there is no drawer, and the breakdown adds up', () => {
  const db = memoryDb();
  const pool = aaa(db);
  const res = place(db, { pool_id: pool.id, label: 'Tren Thomas de Ángel', quantity: 3 }, ctx());
  assert.equal(res.legs[0].from.slug, 'sin-ubicar');
  assert.equal(res.legs[0].to.slug, 'tren-thomas-de-angel');
  place(db, { pool_id: pool.id, label: 'Tren Percy de Ángel', quantity: 3 }, ctx());
  place(db, { pool_id: pool.id, label: 'Cajón', kind: 'drawer', quantity: 4 }, ctx());
  const [p] = summary(db);
  assert.deepEqual(p.breakdown, { device: 6, charger: 0, drawer: 4, missing: 14 });
  assert.equal(placedSum(db, pool.id), 24);
});

test('6b · once a drawer exists, place takes from the drawer', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Cajón', kind: 'drawer', quantity: 4 }, ctx());
  const res = place(db, { pool_id: pool.id, label: 'Control minisplit', quantity: 2 }, ctx());
  assert.equal(res.legs[0].from.slug, 'cajon');
  assert.deepEqual(summary(db)[0].breakdown, { device: 2, charger: 0, drawer: 2, missing: 6 });
});

test('6b2 · placing into a charger or drawer registers them out of Sin ubicar, even with a drawer', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Cajón', kind: 'drawer', quantity: 4 }, ctx());
  const res = place(db, { pool_id: pool.id, label: 'Cargador', kind: 'charger', quantity: 2 }, ctx());
  assert.equal(res.legs[0].from.slug, 'sin-ubicar');
  assert.deepEqual(summary(db)[0].breakdown, { device: 0, charger: 2, drawer: 4, missing: 4 });
});

test('6c · a drawer with too few batteries is insufficient_drawer, not a silent take from Sin ubicar', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Cajón', kind: 'drawer', quantity: 1 }, ctx());
  const err = catchDomain(() => place(db, { pool_id: pool.id, label: 'Control', quantity: 2 }, ctx()));
  assert.equal(err.reason, 'insufficient_drawer');
  assert.equal(err.code, 409);
  assert.equal(err.details.available, 1);
  // Saying explicitly where they came from works.
  const res = place(db, { pool_id: pool.id, label: 'Control', quantity: 2, from_slug: 'sin-ubicar' }, ctx());
  assert.equal(res.legs[0].from.slug, 'sin-ubicar');
});

test('7 · placing more than the stock is stock_exceeded and writes nothing', () => {
  const db = memoryDb();
  const pool = aaa(db, 5);
  place(db, { pool_id: pool.id, label: 'Tren', quantity: 3 }, ctx());
  const before = { a: count(db, 'allocations'), m: count(db, 'movements'), rows: activeRows(db, pool.id) };
  const err = catchDomain(() => place(db, { pool_id: pool.id, label: 'Control', quantity: 3 }, ctx()));
  assert.equal(err.reason, 'stock_exceeded');
  assert.equal(err.code, 409);
  assert.deepEqual(err.details.breakdown, { device: 3, charger: 0, drawer: 0, missing: 2 });
  assert.equal(count(db, 'allocations'), before.a);
  assert.equal(count(db, 'movements'), before.m);
  assert.deepEqual(activeRows(db, pool.id), before.rows);
});

test('9 · a partial move (3 of 5) leaves 2 behind and 3 at the destination', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Cajón', kind: 'drawer', quantity: 5 }, ctx());
  moveTo(db, { from_slug: 'cajon', to_label: 'Cargador', kind: 'charger', quantity: 3 }, ctx());
  const rows = activeRows(db, pool.id).filter((r) => r.kind !== 'missing');
  assert.deepEqual(rows, [
    { kind: 'drawer', slug: 'cajon', label: 'Cajón', quantity: 2 },
    { kind: 'charger', slug: 'cargador', label: 'Cargador', quantity: 3 },
  ]);
  assert.equal(placedSum(db, pool.id), 10);
});

test('10 · moving into an existing place adds to it; into a new one creates it', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Tren', quantity: 3, from_slug: 'sin-ubicar' }, ctx());
  place(db, { pool_id: pool.id, label: 'Cargador', kind: 'charger', quantity: 2, from_slug: 'sin-ubicar' }, ctx());
  moveTo(db, { from_slug: 'tren', to_label: 'cargador' }, ctx()); // whole place, existing destination
  let rows = activeRows(db, pool.id).filter((r) => r.kind !== 'missing');
  assert.deepEqual(rows, [{ kind: 'charger', slug: 'cargador', label: 'Cargador', quantity: 5 }]);
  moveTo(db, { from_slug: 'cargador', to_label: 'Control TV sala', quantity: 2 }, ctx());
  rows = activeRows(db, pool.id).filter((r) => r.kind !== 'missing');
  assert.deepEqual(rows.map((r) => [r.slug, r.kind, r.quantity]), [['cargador', 'charger', 3], ['control-tv-sala', 'device', 2]]);
});

test('10b · moving to Sin ubicar is losing them: total stays, Sin ubicar grows', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Tren', quantity: 3 }, ctx());
  moveTo(db, { from_slug: 'tren', to_label: 'Sin ubicar', quantity: 1 }, ctx());
  const [p] = summary(db);
  assert.equal(p.total, 10);
  assert.deepEqual(p.breakdown, { device: 2, charger: 0, drawer: 0, missing: 8 });
});

test('10c · moving more than a place holds, or within the same place, is refused', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Tren', quantity: 3 }, ctx());
  assert.equal(catchDomain(() => moveTo(db, { from_slug: 'tren', to_label: 'Cargador', quantity: 4 }, ctx())).reason, 'stock_exceeded');
  assert.equal(catchDomain(() => moveTo(db, { from_slug: 'tren', to_label: 'TREN' }, ctx())).reason, 'invalid_input');
});

test('10d · a place holding two pools needs pool_id for a partial move', () => {
  const db = memoryDb();
  const a = aaa(db, 10);
  const b = createPool(db, { kind: 'AAA', brand: 'Amazon Basics', total: 4 }, ctx());
  place(db, { pool_id: a.id, label: 'Tren', quantity: 2 }, ctx());
  place(db, { pool_id: b.id, label: 'Tren', quantity: 1 }, ctx());
  const err = catchDomain(() => moveTo(db, { from_slug: 'tren', to_label: 'Cargador', quantity: 1 }, ctx()));
  assert.equal(err.reason, 'ambiguous_target');
  assert.equal(err.details.candidates.length, 2);
  // Without a quantity the whole place moves, both pools.
  const res = moveTo(db, { from_slug: 'tren', to_label: 'Cargador', kind: 'charger' }, ctx());
  assert.equal(res.legs.length, 2);
  assert.equal(placesList(db).find((p) => p.slug === 'cargador').items.length, 2);
});

test('10e · unknown and emptied places answer place_not_found and allocation_closed', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  assert.equal(catchDomain(() => moveTo(db, { from_slug: 'nada', to_label: 'X' }, ctx())).reason, 'place_not_found');
  place(db, { pool_id: pool.id, label: 'Tren', quantity: 3 }, ctx());
  moveTo(db, { from_slug: 'tren', to_label: 'Cargador' }, ctx());
  const err = catchDomain(() => moveTo(db, { from_slug: 'tren', to_label: 'Cargador' }, ctx()));
  assert.equal(err.reason, 'allocation_closed');
  assert.equal(err.code, 409);
});

test('13 · discard lowers the total and removes the place from the breakdown', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Control', quantity: 2 }, ctx());
  discard(db, { slug: 'control' }, ctx());
  const [p] = summary(db);
  assert.equal(p.total, 8);
  assert.deepEqual(p.breakdown, { device: 0, charger: 0, drawer: 0, missing: 8 });
  assert.equal(placesList(db).length, 0);
  const closed = db.prepare("SELECT closed_reason FROM allocations WHERE slug = 'control'").get();
  assert.equal(closed.closed_reason, 'discarded');
});

test('13b · discarding part of a place, and giving up unaccounted ones from Sin ubicar', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Cargador', kind: 'charger', quantity: 4 }, ctx());
  discard(db, { slug: 'cargador', quantity: 1 }, ctx());
  discard(db, { slug: 'sin-ubicar', pool_id: pool.id, quantity: 2 }, ctx());
  const [p] = summary(db);
  assert.equal(p.total, 7);
  assert.deepEqual(p.breakdown, { device: 0, charger: 3, drawer: 0, missing: 4 });
  assert.equal(catchDomain(() => discard(db, { slug: 'sin-ubicar', pool_id: pool.id, quantity: 5 }, ctx())).reason, 'stock_exceeded');
});

test('14 · lowering the total below what is placed is stock_exceeded with the breakdown', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Tren', quantity: 6 }, ctx());
  const err = catchDomain(() => updatePool(db, { pool_id: pool.id, total: 5 }, ctx()));
  assert.equal(err.reason, 'stock_exceeded');
  assert.deepEqual(err.details.breakdown, { device: 6, charger: 0, drawer: 0, missing: 4 });
  assert.equal(poolTotal(db, pool.id), 10);
  // Down to exactly what is placed closes Sin ubicar; going up reopens it.
  updatePool(db, { pool_id: pool.id, total: 6 }, ctx());
  assert.equal(activeRows(db, pool.id).some((r) => r.kind === 'missing'), false);
  const up = updatePool(db, { pool_id: pool.id, total: 18 }, ctx());
  assert.equal(up.breakdown.missing, 12);
});

test('14b · updatePool edits descriptive fields and keeps identity unique', () => {
  const db = memoryDb();
  const a = aaa(db, 10);
  const b = createPool(db, { kind: 'AA', brand: 'Panasonic', product_line: 'Eneloop', total: 8 }, ctx());
  const edited = updatePool(db, { pool_id: b.id, capacity_mah: 2000, notes: 'caja azul' }, ctx());
  assert.equal(edited.capacity_mah, 2000);
  assert.equal(edited.notes, 'caja azul');
  const err = catchDomain(() => updatePool(db, { pool_id: b.id, kind: 'AAA', brand: 'duracell', product_line: 'recharge', capacity_mah: null }, ctx()));
  assert.equal(err.reason, 'pool_exists');
  assert.equal(err.details.pool_id, a.id);
});

test('15 · pool_exists ignores case and spaces, also with no line', () => {
  const db = memoryDb();
  const first = createPool(db, { kind: 'AAA', brand: 'Duracell', total: 24 }, ctx());
  const err = catchDomain(() => createPool(db, { kind: 'aaa', brand: 'duracell ', total: 4 }, ctx()));
  assert.equal(err.reason, 'pool_exists');
  assert.equal(err.code, 409);
  assert.equal(err.details.pool_id, first.id);
  // A different line is a different pool.
  assert.doesNotThrow(() => createPool(db, { kind: 'AAA', brand: 'Duracell', product_line: 'Recharge', total: 4 }, ctx()));
});

test('16 · archiving leaves the pool out of the summary and keeps its places, closed', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Tren', quantity: 3 }, ctx());
  archivePool(db, { pool_id: pool.id }, ctx());
  assert.equal(summary(db).length, 0);
  assert.equal(summary(db, { include_archived: true }).length, 1);
  assert.equal(placesList(db).length, 0);
  assert.equal(activeRows(db, pool.id).length, 0);
  assert.equal(db.prepare('SELECT count(*) AS c FROM allocations WHERE pool_id = ?').get(pool.id).c, 2);
  // Archived pools take no more writes, and their identity is free again.
  assert.equal(catchDomain(() => place(db, { pool_id: pool.id, label: 'X', quantity: 1 }, ctx())).reason, 'pool_not_found');
  assert.doesNotThrow(() => aaa(db, 5));
});

test('17 · request_id: same payload returns the earlier result, a different one is request_id_reused', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  const body = { pool_id: pool.id, label: 'Tren', quantity: 3, request_id: 'r-1' };
  const first = place(db, body, ctx());
  const moves = count(db, 'movements');
  const again = place(db, { ...body }, ctx());
  assert.deepEqual(again, first);
  assert.equal(count(db, 'movements'), moves);
  assert.equal(summary(db)[0].breakdown.device, 3);
  const err = catchDomain(() => place(db, { ...body, quantity: 2 }, ctx()));
  assert.equal(err.reason, 'request_id_reused');
  assert.equal(err.code, 409);
  // A request id belongs to one operation, not to one operation per type.
  assert.equal(catchDomain(() => discard(db, { slug: 'tren', request_id: 'r-1' }, ctx())).reason, 'request_id_reused');
});

test('18 · every mutation writes movements with from/to, actor and via', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Tren Thomas', quantity: 3 }, ctx({ via: 'mcp', actorName: 'Marco' }));
  moveTo(db, { from_slug: 'tren-thomas', to_label: 'Cargador', kind: 'charger' }, ctx({ actorUserId: 2, actorName: 'Yesenia' }));
  discard(db, { slug: 'cargador', quantity: 1 }, ctx());
  updatePool(db, { pool_id: pool.id, total: 12 }, ctx());
  const rows = db.prepare('SELECT action, quantity, from_label, to_label, actor_user_id, actor_name, via FROM movements ORDER BY id').all()
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { action: 'pool_created', quantity: 10, from_label: null, to_label: null, actor_user_id: 1, actor_name: 'Marco', via: 'ui' },
    { action: 'placed', quantity: 3, from_label: 'Sin ubicar', to_label: 'Tren Thomas', actor_user_id: 1, actor_name: 'Marco', via: 'mcp' },
    { action: 'moved', quantity: 3, from_label: 'Tren Thomas', to_label: 'Cargador', actor_user_id: 2, actor_name: 'Yesenia', via: 'ui' },
    { action: 'discarded', quantity: 1, from_label: 'Cargador', to_label: null, actor_user_id: 1, actor_name: 'Marco', via: 'ui' },
    { action: 'pool_adjusted', quantity: 3, from_label: null, to_label: null, actor_user_id: 1, actor_name: 'Marco', via: 'ui' },
  ]);
});

test('19 · placesList reports age_days on the Mérida calendar', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Tren', quantity: 3, placed_on: '2026-11-12' }, ctx());
  const lateEvening = new Date('2026-11-24T05:30:00Z'); // 23:30 on the 23rd in Mérida
  assert.equal(placesList(db, { now: lateEvening })[0].items[0].age_days, 11);
  const afterMidnight = new Date('2026-11-24T06:30:00Z'); // 00:30 on the 24th
  assert.equal(placesList(db, { now: afterMidnight })[0].items[0].age_days, 12);
  // "Today" for a new placement is the Mérida date too.
  place(db, { pool_id: pool.id, label: 'Control', quantity: 1 }, ctx({ now: lateEvening }));
  assert.equal(db.prepare("SELECT placed_on FROM allocations WHERE slug = 'control'").get().placed_on, '2026-11-23');
});

test('placesList groups a place holding several pools; Sin ubicar is not a card', () => {
  const db = memoryDb();
  const a = aaa(db, 10);
  const b = createPool(db, { kind: 'AAA', brand: 'Amazon Basics', total: 4 }, ctx());
  place(db, { pool_id: a.id, label: 'Tren Thomas', quantity: 2 }, ctx());
  place(db, { pool_id: b.id, label: 'tren thomas', quantity: 1 }, ctx());
  const list = placesList(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].slug, 'tren-thomas');
  assert.equal(list[0].label, 'Tren Thomas'); // first label wins for the card
  assert.equal(list[0].kind, 'device');
  assert.deepEqual(list[0].items.map((i) => [i.pool_name, i.quantity]), [['AAA Duracell Recharge', 2], ['AAA Amazon Basics', 1]]);
  assert.ok(placesList(db, { include_missing: true }).some((p) => p.kind === 'missing'));
});

test('placeHistory lists what went in and out of a place, newest first', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  place(db, { pool_id: pool.id, label: 'Tren', quantity: 3 }, ctx());
  moveTo(db, { from_slug: 'tren', to_label: 'Cargador', kind: 'charger', quantity: 1 }, ctx());
  place(db, { pool_id: pool.id, label: 'Control', quantity: 1 }, ctx());
  const h = placeHistory(db, { slug: 'tren' });
  assert.deepEqual(h.map((m) => m.action), ['moved', 'placed']);
});

test('input validation: labels, quantities, dates and the reserved Sin ubicar name', () => {
  const db = memoryDb();
  const pool = aaa(db, 10);
  const bad = [
    { pool_id: pool.id, label: '  ', quantity: 1 },
    { pool_id: pool.id, label: 'Tren', quantity: 0 },
    { pool_id: pool.id, label: 'Tren', quantity: 1.5 },
    { pool_id: pool.id, label: 'Tren', quantity: 1, placed_on: '2026-02-30' },
    { pool_id: pool.id, label: 'Tren', quantity: 1, placed_on: '2026-12-01' }, // future
    { pool_id: pool.id, label: 'Tren', quantity: 1, kind: 'missing' },
    { pool_id: pool.id, label: 'sin ubicar', quantity: 1 },
  ];
  for (const input of bad) {
    const err = catchDomain(() => place(db, input, ctx()));
    assert.equal(err.reason, 'invalid_input', JSON.stringify(input));
    assert.equal(err.code, 400);
  }
  assert.equal(catchDomain(() => place(db, { pool_id: 999, label: 'X', quantity: 1 }, ctx())).reason, 'pool_not_found');
  assert.equal(catchDomain(() => createPool(db, { kind: 'AAA', brand: 'X', total: -1 }, ctx())).reason, 'invalid_input');
  assert.equal(catchDomain(() => place(db, { pool_id: pool.id, label: 'T', quantity: 1 }, ctx({ via: 'cli' }))).reason, 'invalid_input');
});
