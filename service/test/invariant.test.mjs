// Property check: whatever sequence of operations runs, accepted or refused, every pool's
// active places (Sin ubicar included) add up to its total, and nothing is ever negative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { change, createPool, discard, find, moveTo, place, updatePool } from '../app/places.mjs';
import { DomainError } from '../app/errors.mjs';
import { ctx, memoryDb, placedSum, poolTotal } from './helpers.mjs';

// Small deterministic PRNG so a failure is reproducible from its seed.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test('Σ places = total after 600 random operations (accepted or refused)', () => {
  for (const seed of [1, 7, 42]) {
    const rand = rng(seed);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const db = memoryDb();
    const pools = [
      createPool(db, { kind: 'AAA', brand: 'Duracell', total: 24 }, ctx()).id,
      createPool(db, { kind: 'AA', brand: 'Eneloop', total: 12 }, ctx()).id,
    ];
    const labels = ['Tren Thomas', 'Tren Percy', 'Control TV', 'Minisplit'];
    const ops = [
      () => place(db, { pool_id: pick(pools), label: pick(labels), quantity: 1 + Math.floor(rand() * 4) }, ctx()),
      () => place(db, { pool_id: pick(pools), label: 'Cajón', kind: 'drawer', quantity: 1 + Math.floor(rand() * 4), from_slug: 'sin-ubicar' }, ctx()),
      () => moveTo(db, { from_slug: pick(['tren-thomas', 'tren-percy', 'control-tv', 'cajon', 'cargador']), to_label: pick([...labels, 'Cargador', 'Sin ubicar']), quantity: rand() < 0.5 ? undefined : 1 + Math.floor(rand() * 3), pool_id: rand() < 0.5 ? pick(pools) : undefined, kind: 'charger' }, ctx()),
      () => change(db, { label: pick(labels), old_to: pick(['charger', 'drawer', 'trash']) }, ctx()),
      () => find(db, { pool_id: pick(pools), quantity: 1 + Math.floor(rand() * 3), to_label: pick(labels) }, ctx()),
      () => discard(db, { slug: pick(['tren-thomas', 'cargador', 'sin-ubicar']), pool_id: pick(pools), quantity: 1 }, ctx()),
      () => updatePool(db, { pool_id: pick(pools), total: Math.floor(rand() * 30) }, ctx()),
    ];
    let accepted = 0;
    for (let i = 0; i < 200; i += 1) {
      try {
        pick(ops)();
        accepted += 1;
      } catch (err) {
        if (!(err instanceof DomainError)) throw err; // only domain refusals are expected
      }
      for (const id of pools) {
        assert.equal(placedSum(db, id), poolTotal(db, id), `seed ${seed}, step ${i}, pool ${id}`);
      }
    }
    assert.ok(accepted > 40, `seed ${seed}: too few accepted operations (${accepted}) to mean anything`);
  }
});
