// Page entry of the batteries module (/m/batteries). Two screens in one page: the places (home)
// and the stock sheet opened from a pool line. One state object; every change redraws from it;
// one delegated listener per event type, attached once.
import { esc } from '/utils/html.js';
import { ext } from './lib/client.js';
import { errorParts, newRequestId, prefill, todayLocal } from './lib/format.js';
import {
  renderButton, renderChangeForm, renderDiscardForm, renderEmpty, renderFindForm, renderHistory, renderMoveForm,
  renderNotice, renderPlaceForm, renderPlaces, renderPools, renderStockSheet, tt,
} from './lib/views.js';

// Refusals after which what the page shows may be stale: reload the real numbers.
const RELOAD_ON = new Set(['stock_exceeded', 'insufficient_drawer', 'allocation_closed', 'place_not_found', 'pool_not_found']);

export async function render(container, { signal } = {}) {
  const state = {
    access: 'read', pools: [], places: [], labels: [], focus: null,
    panel: null, busy: false, notice: null, error: null, loaded: false,
  };
  const root = document.createElement('div');
  root.className = 'batteries';
  container.replaceChildren(root);
  const canWrite = () => state.access === 'write';
  const aborted = () => signal?.aborted;

  // ---- drawing ----

  function panelFor(where) {
    const p = state.panel;
    if (!p) return '';
    const today = todayLocal();
    const card = p.slug ? state.places.find((c) => c.slug === p.slug) : null;
    const pool = typeof p.poolId === 'number' ? state.pools.find((x) => x.id === p.poolId) : null;
    if (where === 'pools' && p.type === 'stock') return renderStockSheet({ pool, busy: state.busy });
    if (where === 'pools' && p.type === 'find' && pool) return renderFindForm({ pool, labels: state.labels, today, busy: state.busy });
    if (where === 'places' && p.type === 'place') {
      return renderPlaceForm({ pools: state.pools, labels: state.labels, places: state.places, today, busy: state.busy, values: p.values ?? {} });
    }
    if (where === 'places' && card) {
      if (p.type === 'move') return renderMoveForm({ card, labels: state.labels, busy: state.busy });
      if (p.type === 'change') return renderChangeForm({ card, busy: state.busy });
      if (p.type === 'discard') return renderDiscardForm({ card, busy: state.busy });
      if (p.type === 'history') return renderHistory({ card, rows: p.rows ?? [] });
    }
    return '';
  }

  function draw() {
    if (aborted()) return;
    const titleHtml = `<div class="page-toolbar page-toolbar--narrow"><h1 class="page-toolbar__title">${esc(tt('title'))}</h1></div>`;
    let bodyHtml;
    if (state.error) {
      const retryHtml = renderButton({ action: 'retry', label: tt('action.retry'), variant: 'primary', icon: 'refresh-cw' });
      bodyHtml = `<section class="page-section page-measure" role="alert">${renderEmpty({ icon: 'triangle-alert', title: tt('error.load'), description: tt(...errorParts(state.error)) })}${retryHtml}</section>`;
    } else if (!state.loaded) {
      bodyHtml = `<section class="page-section page-measure"><p class="batteries-loading">${esc(tt('loading'))}</p></section>`;
    } else if (state.access === 'none') {
      bodyHtml = `<section class="page-section page-measure">${renderEmpty({ icon: 'lock', title: tt('noAccess.title'), description: tt('noAccess.description') })}</section>`;
    } else {
      const readOnlyHtml = canWrite() ? '' : `<p class="batteries-readonly">${esc(tt('readOnly'))}</p>`;
      const noticeHtml = state.notice ? renderNotice(state.notice) : '';
      const p = state.panel;
      const poolsPanelId = p && (p.type === 'stock' || p.type === 'find') ? p.poolId : null;
      const placesSlug = p && p.type === 'place' ? '' : (p?.slug ?? null);
      const poolsHtml = renderPools({ pools: state.pools, canWrite: canWrite(), busy: state.busy, openPoolId: poolsPanelId, panelHtml: panelFor('pools') });
      const placesHtml = renderPlaces({ places: state.places, canWrite: canWrite(), busy: state.busy, openSlug: placesSlug, panelHtml: panelFor('places') });
      bodyHtml = `<div class="app-page__body">${readOnlyHtml}${noticeHtml}${poolsHtml}${placesHtml}</div>`;
    }
    root.replaceChildren();
    root.insertAdjacentHTML('beforeend', titleHtml + bodyHtml);
    if (state.focus) root.querySelector(`[data-slug="${CSS.escape(state.focus)}"]`)?.classList.add('batteries-card--focus');
    window.lucide?.createIcons?.({ el: root });
  }

  // ---- loading ----

  async function reload() {
    const [pools, places, labels] = await Promise.all([
      ext.get('/summary', { signal }), ext.get('/places', { signal }), ext.get('/labels', { signal }),
    ]);
    Object.assign(state, { pools, places, labels });
  }

  async function load() {
    state.error = null;
    try {
      const me = await ext.get('/me', { signal });
      state.access = me.access;
      if (me.access !== 'none') await reload();
      // ?lugar=<slug> (the QR of v1.1): highlight that place if it holds batteries.
      const wanted = new URLSearchParams(location.search).get('lugar');
      state.focus = wanted && state.places.some((c) => c.slug === wanted) ? wanted : null;
      state.loaded = true;
    } catch (err) {
      if (aborted()) return;
      state.error = err;
    }
    draw();
    if (state.focus) root.querySelector('.batteries-card--focus')?.scrollIntoView?.({ block: 'center' });
  }

  // ---- writes ----

  // One write at a time; the panel stays open on a refusal (with its values) and closes on success.
  async function mutate(send) {
    if (state.busy || !canWrite()) return;
    state.busy = true;
    state.notice = null;
    draw();
    try {
      await send(state.panel?.requestId ?? newRequestId());
      state.panel = null;
      state.notice = { kind: 'ok', text: tt('notice.saved') };
      await reload();
    } catch (err) {
      if (aborted()) return;
      state.notice = { kind: 'error', text: tt(...errorParts(err)) };
      if (RELOAD_ON.has(err?.reason)) await reload().catch(() => {});
    }
    state.busy = false;
    draw();
  }

  const open = (panel) => { state.panel = { requestId: newRequestId(), ...panel }; state.notice = null; draw(); };

  // ---- reading forms ----

  const str = (fd, name) => String(fd.get(name) ?? '').trim();
  const int = (fd, name) => { const v = str(fd, name); return v === '' ? undefined : Number(v); };

  function submitBody(form, requestId) {
    const fd = new FormData(form);
    const slug = form.dataset.slug;
    switch (form.dataset.form) {
      case 'place': {
        const placedOn = str(fd, 'placed_on');
        return ['/places/place', {
          pool_id: int(fd, 'pool_id'), label: str(fd, 'label'), kind: str(fd, 'kind'), quantity: int(fd, 'quantity'),
          from_slug: str(fd, 'from_slug') || undefined, placed_on: placedOn && placedOn !== todayLocal() ? placedOn : undefined, request_id: requestId,
        }];
      }
      case 'move':
        return ['/places/move', { from_slug: slug, to_label: str(fd, 'to_label'), kind: str(fd, 'kind'), quantity: int(fd, 'quantity'), pool_id: int(fd, 'pool_id'), request_id: requestId }];
      case 'change':
        return ['/places/change', { slug, old_to: str(fd, 'old_to'), new_quantity: int(fd, 'new_quantity'), request_id: requestId }];
      case 'discard':
        return ['/places/discard', { slug, quantity: int(fd, 'quantity'), pool_id: int(fd, 'pool_id'), request_id: requestId }];
      case 'find': {
        const placedOn = str(fd, 'placed_on');
        return ['/places/find', {
          pool_id: Number(form.dataset.pool), quantity: int(fd, 'quantity'), to_label: str(fd, 'to_label'), kind: str(fd, 'kind'),
          placed_on: placedOn && placedOn !== todayLocal() ? placedOn : undefined, request_id: requestId,
        }];
      }
      case 'stock': {
        const fields = {
          kind: str(fd, 'kind'), brand: str(fd, 'brand'), product_line: str(fd, 'product_line') || null,
          capacity_mah: int(fd, 'capacity_mah') ?? null, total: int(fd, 'total'), notes: str(fd, 'notes') || null, request_id: requestId,
        };
        if (form.dataset.pool === 'new') return ['/pools', fields, 'post'];
        return [`/pools/${Number(form.dataset.pool)}`, fields, 'patch'];
      }
      default:
        return null;
    }
  }

  // ---- events ----

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || !root.contains(button) || button.disabled) return;
    const { action, slug, pool } = button.dataset;
    switch (action) {
      case 'retry': load(); break;
      case 'cancel': state.panel = null; draw(); break;
      case 'place': open({ type: 'place', values: {} }); break;
      case 'stock-new': open({ type: 'stock', poolId: 'new' }); break;
      case 'stock-edit': open({ type: 'stock', poolId: Number(pool) }); break;
      case 'find': open({ type: 'find', poolId: Number(pool) }); break;
      case 'move': case 'change': case 'discard': open({ type: action, slug }); break;
      case 'history':
        ext.get(`/places/${encodeURIComponent(slug)}/history`, { signal })
          .then((rows) => open({ type: 'history', slug, rows }))
          .catch((err) => { if (!aborted()) { state.notice = { kind: 'error', text: tt(...errorParts(err)) }; draw(); } });
        break;
      case 'archive':
        if (window.confirm(tt('confirm.archive'))) mutate((rid) => ext.post(`/pools/${Number(pool)}/archive`, { request_id: rid }, { signal }));
        break;
      default: break;
    }
  }, { signal });

  root.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    if (form.dataset.form === 'discard' && !window.confirm(tt('confirm.discard'))) return;
    if (form.dataset.form === 'place') {
      // Keep what was typed if the server refuses (the page redraws while the request runs).
      const fd = new FormData(form);
      state.panel.values = Object.fromEntries(['label', 'kind', 'pool_id', 'quantity', 'from_slug', 'placed_on'].map((k) => [k, fd.get(k)]));
    }
    mutate((requestId) => {
      const [path, body, method = 'post'] = submitBody(form, requestId);
      return ext[method](path, body, { signal });
    });
  }, { signal });

  // Implicit template: a known place fills in its kind, pool and quantity from its last use.
  root.addEventListener('change', (event) => {
    const input = event.target;
    if (input.name !== 'label' || !input.form || input.form.dataset.form !== 'place') return;
    const p = prefill(state.labels, input.value);
    if (!p) return;
    const f = input.form;
    f.elements.kind.value = p.kind;
    if ([...f.elements.pool_id.options].some((o) => Number(o.value) === p.pool_id)) f.elements.pool_id.value = String(p.pool_id);
    f.elements.quantity.value = String(p.quantity);
  }, { signal });

  draw();
  await load();
}
