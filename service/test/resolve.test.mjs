// Domain helpers the MCP facade needs: add stock, last use of a place, and resolving the
// free text an agent hears ("el tren", "AAA Duracell") to one place or pool — or refusing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addStock, archivePool, createPool, lastUse, moveTo, place, receiveStock, resolveDestination, resolvePlace,
  resolvePool, runIdempotent,
} from '../app/places.mjs';
import { catchDomain, count, ctx, memoryDb } from './helpers.mjs';

function house(db) {
  const aaa = createPool(db, { kind: 'AAA', brand: 'Duracell', product_line: 'Recharge', total: 24 }, ctx());
  const aaa2 = createPool(db, { kind: 'AAA', brand: 'Amazon Basics', total: 8 }, ctx());
  const aa = createPool(db, { kind: 'AA', brand: 'Panasonic', product_line: 'Eneloop', total: 12 }, ctx());
  place(db, { pool_id: aaa.id, label: 'Tren Thomas de Ángel', quantity: 3 }, ctx());
  place(db, { pool_id: aaa.id, label: 'Tren Percy de Ángel', quantity: 3 }, ctx());
  place(db, { pool_id: aa.id, label: 'Control TV sala', quantity: 2 }, ctx());
  place(db, { pool_id: aaa.id, label: 'Cargador cocina', kind: 'charger', quantity: 2 }, ctx());
  return { aaa, aaa2, aa };
}

test('addStock adds to the total and to Sin ubicar, in one movement', () => {
  const db = memoryDb();
  const { aa } = house(db);
  const moves = count(db, 'movements');
  const pool = addStock(db, { pool_id: aa.id, delta: 12 }, ctx());
  assert.equal(pool.total, 24);
  assert.equal(pool.breakdown.missing, 22);
  assert.equal(count(db, 'movements'), moves + 1);
  assert.equal(catchDomain(() => addStock(db, { pool_id: aa.id, delta: 0 }, ctx())).reason, 'invalid_input');
});

test('receiveStock creates the pool the first time, adds later, and refuses to guess between lines', () => {
  const db = memoryDb();
  house(db);
  const first = receiveStock(db, { kind: 'AA', brand: 'IKEA', product_line: 'Ladda', delta: 4 }, ctx());
  assert.equal(first.created, true);
  assert.equal(first.pool.total, 4);
  const again = receiveStock(db, { kind: 'aa', brand: 'ikea', delta: 2 }, ctx()); // only one IKEA AA: no line needed
  assert.equal(again.created, false);
  assert.equal(again.pool.total, 6);
  receiveStock(db, { kind: 'AA', brand: 'IKEA', product_line: 'Ladda 2450', delta: 1 }, ctx());
  const err = catchDomain(() => receiveStock(db, { kind: 'AA', brand: 'IKEA', delta: 1 }, ctx()));
  assert.equal(err.reason, 'ambiguous_target');
  assert.equal(err.details.candidates.length, 2);
});

test('runIdempotent wraps resolution and write in one transaction under one request_id', () => {
  const db = memoryDb();
  const { aaa } = house(db);
  const run = () => runIdempotent(db, 'mcp:mover', { desde: 'tren thomas', request_id: 'x-1' }, ctx(), (args, c) => {
    const src = resolvePlace(db, args.desde);
    return moveTo(db, { from_slug: src.slug, to_label: 'Cargador cocina' }, c);
  });
  const a = run();
  const b = run(); // the place is empty now: a second resolution would fail, the replay does not
  assert.deepEqual(b, a);
  assert.equal(db.prepare("SELECT request_id FROM movements WHERE action = 'moved'").get().request_id, 'x-1');
  // A failure inside rolls back what the inner operations wrote.
  const moves = count(db, 'movements');
  assert.equal(catchDomain(() => runIdempotent(db, 'mcp:x', {}, ctx(), (_a, c) => {
    place(db, { pool_id: aaa.id, label: 'Sofá', quantity: 1 }, c);
    resolvePlace(db, 'nada');
  })).reason, 'place_not_found');
  assert.equal(count(db, 'movements'), moves);
});

test('lastUse gives the pool and quantity a place had last, even after it was emptied', () => {
  const db = memoryDb();
  const { aaa } = house(db);
  moveTo(db, { from_slug: 'tren-percy-de-angel', to_label: 'Cargador cocina' }, ctx());
  assert.deepEqual(lastUse(db, 'tren-percy-de-angel'), { pool_id: aaa.id, quantity: 3, kind: 'device', label: 'Tren Percy de Ángel' });
  assert.equal(lastUse(db, 'nada'), null);
});

test('resolvePlace: exact slug, unique partial match, ambiguity with candidates, not found', () => {
  const db = memoryDb();
  house(db);
  assert.equal(resolvePlace(db, 'Tren Thomas de Ángel').slug, 'tren-thomas-de-angel');
  assert.equal(resolvePlace(db, 'el tren de Percy').slug, 'tren-percy-de-angel'); // stopwords ignored
  assert.equal(resolvePlace(db, 'control de la tv').slug, 'control-tv-sala');
  const err = catchDomain(() => resolvePlace(db, 'el tren'));
  assert.equal(err.reason, 'ambiguous_target');
  assert.deepEqual(err.details.candidates.map((c) => c.slug).sort(), ['tren-percy-de-angel', 'tren-thomas-de-angel']);
  assert.equal(catchDomain(() => resolvePlace(db, 'minisplit')).reason, 'place_not_found');
  assert.equal(resolvePlace(db, 'sin ubicar').kind, 'missing');
});

test('resolvePlace on an emptied place is allocation_closed, not a silent new place', () => {
  const db = memoryDb();
  house(db);
  moveTo(db, { from_slug: 'control-tv-sala', to_label: 'Cargador cocina' }, ctx());
  assert.equal(catchDomain(() => resolvePlace(db, 'control tv sala')).reason, 'allocation_closed');
});

test('resolveDestination: exact place, the only charger/drawer for "cargador"/"cajón", or a new place', () => {
  const db = memoryDb();
  house(db);
  assert.deepEqual(resolveDestination(db, 'Tren Percy de Ángel'), { slug: 'tren-percy-de-angel', label: 'Tren Percy de Ángel', kind: 'device', isNew: false });
  // "al cargador" means the house charger when there is exactly one.
  assert.equal(resolveDestination(db, 'el cargador').slug, 'cargador-cocina');
  // A partial name is NOT matched for a destination: it is a new place.
  assert.deepEqual(resolveDestination(db, 'Control minisplit'), { slug: 'control-minisplit', label: 'Control minisplit', kind: null, isNew: true });
  assert.equal(resolveDestination(db, 'cajón').isNew, true); // there is no drawer yet
  assert.equal(resolveDestination(db, 'sin ubicar').kind, 'missing');
});

test('resolvePool: filters, last use of the place as tie-break, ambiguity, not found', () => {
  const db = memoryDb();
  const { aaa, aaa2, aa } = house(db);
  assert.equal(resolvePool(db, { tipo: 'aa' }).id, aa.id);
  assert.equal(resolvePool(db, { tipo: 'AAA', marca: 'duracell' }).id, aaa.id);
  const err = catchDomain(() => resolvePool(db, { tipo: 'AAA' }));
  assert.equal(err.reason, 'ambiguous_target');
  assert.deepEqual(err.details.candidates.map((c) => c.pool_id).sort(), [aaa.id, aaa2.id].sort());
  // The place's last use breaks the tie (implicit template).
  assert.equal(resolvePool(db, { tipo: 'AAA', hintSlug: 'tren-thomas-de-angel' }).id, aaa.id);
  assert.equal(resolvePool(db, { hintSlug: 'control-tv-sala' }).id, aa.id);
  assert.equal(catchDomain(() => resolvePool(db, {})).reason, 'ambiguous_target');
  assert.equal(catchDomain(() => resolvePool(db, { tipo: '9V' })).reason, 'pool_not_found');
  archivePool(db, { pool_id: aaa2.id }, ctx());
  assert.equal(resolvePool(db, { tipo: 'AAA' }).id, aaa.id);
});
