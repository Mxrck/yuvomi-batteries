// View functions return HTML strings; these tests feed them hostile text and real-shaped data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderChangeForm, renderHistory, renderMoveForm, renderNotice, renderPlaceForm, renderPlaces, renderPools, renderStockSheet,
} from '../../modules/batteries/lib/views.js';

const EVIL = '<img src=x onerror="alert(1)">';
const pool = (over = {}) => ({
  id: 1, name: 'AAA Duracell Recharge', kind: 'AAA', brand: 'Duracell', product_line: 'Recharge', capacity_mah: null,
  total: 24, notes: null, archived_at: null, breakdown: { device: 3, charger: 0, drawer: 0, missing: 21 }, ...over,
});
const card = (over = {}) => ({
  slug: 'tren-thomas', label: 'Tren Thomas', kind: 'device',
  items: [{ allocation_id: 2, pool_id: 1, pool_name: 'AAA Duracell Recharge', quantity: 3, placed_on: '2026-11-12', age_days: 11, checked_on: null, notes: null }],
  ...over,
});
const noRawEvil = (html) => {
  assert.ok(!html.includes('<img'), 'raw <img> leaked');
  assert.ok(!html.includes('onerror="'), 'raw attribute leaked');
};

test('hostile labels, brands, notes and pool names come out escaped everywhere', () => {
  const evilPool = pool({ name: EVIL, brand: EVIL, notes: EVIL });
  const evilCard = card({ label: EVIL, items: [{ ...card().items[0], pool_name: EVIL, notes: EVIL }] });
  const labels = [{ slug: 'x', label: EVIL, kind: 'device', active: true, last: { pool_id: 1, quantity: 1 } }];
  const out = [
    renderPools({ pools: [evilPool], canWrite: true, busy: false }),
    renderPlaces({ places: [evilCard], canWrite: true, busy: false }),
    renderPlaceForm({ pools: [evilPool], labels, places: [evilCard], today: '2026-11-23', busy: false, values: { label: EVIL } }),
    renderMoveForm({ card: evilCard, busy: false }),
    renderChangeForm({ card: evilCard, busy: false }),
    renderStockSheet({ pool: evilPool, busy: false }),
    renderHistory({ card: evilCard, rows: [{ id: 1, action: 'moved', quantity: 1, from_label: EVIL, to_label: EVIL, actor_name: EVIL, via: 'ui', created_at: '2026-11-23T09:00:00Z' }] }),
    renderNotice({ kind: 'error', text: EVIL }),
  ];
  for (const html of out) noRawEvil(html);
  assert.ok(out[1].includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
});

test('pool line shows the breakdown; write actions only for writers; busy disables them', () => {
  const ro = renderPools({ pools: [pool()], canWrite: false, busy: false });
  assert.ok(ro.includes('pool.breakdown(total=24,device=3,charger=0,drawer=0,missing=21)'));
  assert.ok(!ro.includes('data-action="find"'));
  assert.ok(!ro.includes('data-action="stock-new"'));
  const rw = renderPools({ pools: [pool()], canWrite: true, busy: false });
  assert.ok(rw.includes('data-action="find"'));
  assert.ok(rw.includes('data-action="stock-edit"'));
  const busy = renderPools({ pools: [pool()], canWrite: true, busy: true });
  assert.match(busy, /data-action="find"[^>]*disabled/);
  // No find button when nothing is unaccounted for.
  assert.ok(!renderPools({ pools: [pool({ breakdown: { device: 24, charger: 0, drawer: 0, missing: 0 } })], canWrite: true, busy: false }).includes('data-action="find"'));
  assert.ok(renderPools({ pools: [], canWrite: false, busy: false }).includes('pools.empty.title'));
});

test('place cards: age for devices, kind tag otherwise, change only on devices, history for everyone', () => {
  const dev = renderPlaces({ places: [card()], canWrite: false, busy: false });
  assert.ok(dev.includes('age.days(n=11)'));
  assert.ok(dev.includes('data-action="history"'));
  assert.ok(!dev.includes('data-action="change"'));
  const rw = renderPlaces({ places: [card(), card({ slug: 'cargador', label: 'Cargador', kind: 'charger' })], canWrite: true, busy: false });
  assert.equal((rw.match(/data-action="change"/g) || []).length, 1);
  assert.ok(rw.includes('kind.charger'));
  assert.ok(renderPlaces({ places: [card({ items: [{ ...card().items[0], age_days: 0 }] })], canWrite: false, busy: false }).includes('age.today'));
  assert.ok(renderPlaces({ places: [], canWrite: false, busy: false }).includes('places.empty.title'));
});

test('the place form: datalist of known labels, pools as options, today by default, prefilled values', () => {
  const labels = [
    { slug: 'tren-thomas', label: 'Tren Thomas', kind: 'device', active: true, last: { pool_id: 1, quantity: 3 } },
    { slug: 'cargador', label: 'Cargador', kind: 'charger', active: false, last: { pool_id: 1, quantity: 2 } },
  ];
  const html = renderPlaceForm({ pools: [pool(), pool({ id: 2, name: 'AA Eneloop' })], labels, places: [card()], today: '2026-11-23', busy: false,
    values: { label: 'Tren Thomas', pool_id: 2, quantity: 3, kind: 'device' } });
  assert.ok(html.includes('<datalist id="batteries-labels">'));
  assert.ok(html.includes('<option value="Tren Thomas">'));
  assert.ok(html.includes('value="2026-11-23"'));
  assert.match(html, /<option value="2" selected>/);
  assert.match(html, /name="quantity"[^>]*value="3"/);
  assert.ok(html.includes('value="sin-ubicar"'));
  assert.ok(html.includes('value="tren-thomas"'));
});

test('move and change forms adapt to a place holding one pool or several', () => {
  const two = card({ items: [card().items[0], { ...card().items[0], allocation_id: 9, pool_id: 2, pool_name: 'AA Eneloop' }] });
  assert.ok(!renderMoveForm({ card: card(), busy: false }).includes('name="pool_id"'));
  assert.ok(renderMoveForm({ card: two, busy: false }).includes('name="pool_id"'));
  assert.ok(renderChangeForm({ card: card(), busy: false }).includes('name="new_quantity"'));
  assert.ok(!renderChangeForm({ card: two, busy: false }).includes('name="new_quantity"'));
  assert.match(renderChangeForm({ card: card(), busy: false }), /<option value="charger" selected>/);
});

test('stock sheet: new pool form vs edit with archive; history rows are labelled by action', () => {
  const fresh = renderStockSheet({ pool: null, busy: false });
  assert.ok(fresh.includes('name="kind"') && fresh.includes('name="brand"') && fresh.includes('name="total"'));
  assert.ok(!fresh.includes('data-action="archive"'));
  const edit = renderStockSheet({ pool: pool(), busy: false });
  assert.ok(edit.includes('data-action="archive"'));
  assert.match(edit, /name="total"[^>]*value="24"/);
  const hist = renderHistory({ card: card(), rows: [{ id: 1, action: 'changed', quantity: 3, from_label: 'Tren Thomas', to_label: 'Cargador', actor_name: 'Marco', via: 'mcp', created_at: '2026-11-23T09:00:00Z' }] });
  assert.ok(hist.includes('history.action.changed'));
  assert.ok(hist.includes('history.via.mcp'));
  assert.ok(renderHistory({ card: card(), rows: [] }).includes('history.empty'));
});
