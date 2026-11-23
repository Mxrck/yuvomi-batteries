// resumen_humano: one Spanish line per mutation, built from the domain result only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addStock, change, createPool, discard, find, moveTo, place, summary, updatePool, archivePool } from '../app/places.mjs';
import { humanize, poolLine } from '../app/humanize.mjs';
import { ctx, memoryDb } from './helpers.mjs';

function setup() {
  const db = memoryDb();
  const pool = createPool(db, { kind: 'AAA', brand: 'Duracell', product_line: 'Recharge', total: 24 }, ctx());
  place(db, { pool_id: pool.id, label: 'Cajón', kind: 'drawer', quantity: 6 }, ctx());
  return { db, pool };
}

test('every operation gets one line', () => {
  const { db, pool } = setup();
  assert.equal(humanize('createPool', createPool(db, { kind: 'AA', brand: 'Eneloop', total: 8 }, ctx())),
    'Nuevo stock AA Eneloop: 8 (8 sin ubicar)');
  assert.equal(humanize('place', place(db, { pool_id: pool.id, label: 'Tren Thomas de Ángel', quantity: 3 }, ctx())),
    'Tren Thomas de Ángel: 3 AAA Duracell Recharge (desde Cajón)');
  assert.equal(humanize('change', change(db, { label: 'Tren Thomas de Ángel', old_to: 'charger' }, ctx())),
    'Tren Thomas de Ángel: 3 AAA Duracell Recharge nuevas; las viejas → Cargador');
  assert.equal(humanize('move', moveTo(db, { from_slug: 'cargador', to_label: 'Control TV', quantity: 2 }, ctx())),
    '2 AAA Duracell Recharge: Cargador → Control TV');
  assert.equal(humanize('find', find(db, { pool_id: pool.id, quantity: 2, to_label: 'Sofá' }, ctx())),
    'Encontradas 2 AAA Duracell Recharge en Sofá; quedan 16 sin ubicar');
  assert.equal(humanize('discard', discard(db, { slug: 'control-tv' }, ctx())),
    'Desechadas 2 AAA Duracell Recharge de Control TV; el total queda en 22');
  assert.equal(humanize('move', moveTo(db, { from_slug: 'sofa', to_label: 'Sin ubicar' }, ctx())),
    '2 AAA Duracell Recharge: Sofá → Sin ubicar');
  assert.equal(humanize('updatePool', updatePool(db, { pool_id: pool.id, total: 20 }, ctx())),
    'AAA Duracell Recharge: total 20 (16 sin ubicar)');
  assert.equal(humanize('addStock', addStock(db, { pool_id: pool.id, delta: 4 }, ctx())),
    'AAA Duracell Recharge: total 24 (20 sin ubicar)');
  assert.equal(humanize('archivePool', archivePool(db, { pool_id: pool.id }, ctx())), 'AAA Duracell Recharge archivado');
});

test('change to the trash and a pool line for the summary', () => {
  const { db, pool } = setup();
  place(db, { pool_id: pool.id, label: 'Control', quantity: 2 }, ctx());
  assert.equal(humanize('change', change(db, { label: 'Control', old_to: 'trash' }, ctx())),
    'Control: 2 AAA Duracell Recharge nuevas; las viejas → basura');
  assert.equal(poolLine(summary(db)[0]),
    'AAA Duracell Recharge: 22 = 2 en aparatos · 0 en cargador · 2 en cajón · 18 sin ubicar');
});
