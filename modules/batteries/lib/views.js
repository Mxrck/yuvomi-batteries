// Views of the batteries page. Every function returns an HTML string; every value that is not a
// literal of this file goes through esc() (text), num() (numbers) or flag() (fixed attribute
// words). Fragments rendered by another function are passed as …Html. A test enforces this.
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { ageParts } from './format.js';

export const tt = (key, params) => t(`extensions.batteries.${key}`, params);
export const num = (n) => String(Number.isFinite(Number(n)) ? Number(n) : 0);
export const flag = (on, word) => (on ? ` ${word}` : '');

export function kindName(kind) {
  switch (kind) {
    case 'charger': return tt('kind.charger');
    case 'drawer': return tt('kind.drawer');
    case 'missing': return tt('kind.missing');
    default: return tt('kind.device');
  }
}

function historyActionName(action) {
  switch (action) {
    case 'pool_created': return tt('history.action.pool_created');
    case 'pool_adjusted': return tt('history.action.pool_adjusted');
    case 'pool_archived': return tt('history.action.pool_archived');
    case 'placed': return tt('history.action.placed');
    case 'moved': return tt('history.action.moved');
    case 'changed': return tt('history.action.changed');
    case 'found': return tt('history.action.found');
    case 'discarded': return tt('history.action.discarded');
    default: return action;
  }
}

function viaName(via) {
  switch (via) {
    case 'mcp': return tt('history.via.mcp');
    case 'api': return tt('history.via.api');
    default: return tt('history.via.ui');
  }
}

// ---------------------------------------------------------------- small pieces

export function renderButton({ action, label, busy = false, variant = 'secondary', data = {}, type = 'button', icon = '' }) {
  const attrsHtml = Object.entries(data).map(([k, v]) => ` data-${esc(k)}="${esc(v)}"`).join('');
  const iconHtml = icon ? `<i data-lucide="${esc(icon)}" aria-hidden="true" class="icon-sm"></i>` : '';
  return `<button type="${esc(type)}" class="btn btn--${esc(variant)} btn--sm" data-action="${esc(action)}"${attrsHtml}${flag(busy, 'disabled')}>${iconHtml}<span>${esc(label)}</span></button>`;
}

export function renderEmpty({ icon, title, description }) {
  return `<div class="empty-state"><i data-lucide="${esc(icon)}" class="empty-state__icon" aria-hidden="true"></i>`
    + `<h2 class="empty-state__title">${esc(title)}</h2><p class="empty-state__description">${esc(description)}</p></div>`;
}

export function renderNotice({ kind, text }) {
  return `<p class="batteries-notice batteries-notice--${esc(kind)}" role="${esc(kind === 'error' ? 'alert' : 'status')}">${esc(text)}</p>`;
}

function renderField({ label, controlHtml, hint = '' }) {
  const hintHtml = hint ? `<span class="form-hint">${esc(hint)}</span>` : '';
  return `<label class="form-field batteries-field"><span class="form-label">${esc(label)}</span>${controlHtml}${hintHtml}</label>`;
}

function renderOptions(options, selected) {
  return options.map(([value, label]) => `<option value="${esc(value)}"${flag(String(value) === String(selected), 'selected')}>${esc(label)}</option>`).join('');
}

function renderDatalist(id, labels) {
  const optionsHtml = (labels ?? []).map((l) => `<option value="${esc(l.label)}"></option>`).join('');
  return `<datalist id="${esc(id)}">${optionsHtml}</datalist>`;
}

function renderKindSelect(name, selected) {
  const optionsHtml = renderOptions([['device', kindName('device')], ['charger', kindName('charger')], ['drawer', kindName('drawer')]], selected);
  return `<select class="form-input" name="${esc(name)}">${optionsHtml}</select>`;
}

function renderPoolSelect(pools, selected, { allLabel = '' } = {}) {
  const options = pools.map((p) => [p.id, p.name]);
  if (allLabel) options.unshift(['', allLabel]);
  return `<select class="form-input" name="pool_id"${flag(!allLabel, 'required')}>${renderOptions(options, selected ?? '')}</select>`;
}

function renderFormActions({ busy, submitLabel, danger = false }) {
  const submitHtml = `<button type="submit" class="btn btn--${esc(danger ? 'danger' : 'primary')} btn--sm"${flag(busy, 'disabled')}>${esc(submitLabel)}</button>`;
  const cancelHtml = renderButton({ action: 'cancel', label: tt('action.cancel'), variant: 'ghost' });
  return `<div class="batteries-form__actions">${submitHtml}${cancelHtml}</div>`;
}

// ---------------------------------------------------------------- pools

function renderPoolRow(p, { canWrite, busy }) {
  const b = p.breakdown;
  const breakdown = tt('pool.breakdown', { total: p.total, device: b.device, charger: b.charger, drawer: b.drawer, missing: b.missing });
  const notesHtml = p.notes ? `<div class="list-row__meta batteries-notes">${esc(p.notes)}</div>` : '';
  const buttons = [];
  if (canWrite && b.missing > 0) buttons.push(renderButton({ action: 'find', label: tt('action.find'), busy, data: { pool: p.id }, icon: 'search' }));
  if (canWrite) buttons.push(renderButton({ action: 'stock-edit', label: tt('action.stock'), busy, variant: 'ghost', data: { pool: p.id }, icon: 'pencil' }));
  const buttonsHtml = buttons.join('');
  const missingHtml = b.missing > 0 ? `<span class="batteries-missing">${esc(tt('pool.missing', { n: b.missing }))}</span>` : '';
  return `<div class="list-row batteries-pool" data-pool-id="${num(p.id)}">`
    + `<div class="list-row__main"><div class="list-row__name">${esc(p.name)} ${missingHtml}</div>`
    + `<div class="list-row__meta">${esc(breakdown)}</div>${notesHtml}</div>`
    + `<div class="list-row__end batteries-actions">${buttonsHtml}</div></div>`;
}

export function renderPools({ pools, canWrite, busy, openPoolId = null, panelHtml = '' }) {
  const headActionsHtml = canWrite ? renderButton({ action: 'stock-new', label: tt('action.newPool'), busy, icon: 'plus' }) : '';
  const rowsHtml = pools.length
    ? pools.map((p) => renderPoolRow(p, { canWrite, busy }) + (p.id === openPoolId ? panelHtml : '')).join('')
    : renderEmpty({ icon: 'battery', title: tt('pools.empty.title'), description: tt('pools.empty.description') });
  const newPanelHtml = openPoolId === 'new' ? panelHtml : '';
  return `<section class="page-section page-measure batteries-pools">`
    + `<div class="batteries-section-head"><h2 class="batteries-section-title">${esc(tt('pools.title'))}</h2>${headActionsHtml}</div>`
    + `${newPanelHtml}<div class="list-rows">${rowsHtml}</div></section>`;
}

// ---------------------------------------------------------------- places

function renderItem(item, kind) {
  const ageHtml = kind === 'device' ? `<span class="batteries-age">${esc(tt(...ageParts(item.age_days)))}</span>` : '';
  return `<li class="batteries-item"><span>${esc(tt('place.item', { n: item.quantity, pool: item.pool_name }))}</span>${ageHtml}</li>`;
}

function renderCard(c, { canWrite, busy, panelHtml }) {
  const tagHtml = c.kind === 'device' ? '' : `<span class="batteries-tag">${esc(kindName(c.kind))}</span>`;
  const itemsHtml = c.items.map((i) => renderItem(i, c.kind)).join('');
  const buttons = [];
  if (canWrite && c.kind === 'device') buttons.push(renderButton({ action: 'change', label: tt('action.change'), busy, variant: 'primary', data: { slug: c.slug }, icon: 'refresh-cw' }));
  if (canWrite) buttons.push(renderButton({ action: 'move', label: tt('action.move'), busy, data: { slug: c.slug }, icon: 'arrow-right-left' }));
  if (canWrite) buttons.push(renderButton({ action: 'discard', label: tt('action.discard'), busy, variant: 'ghost', data: { slug: c.slug }, icon: 'trash-2' }));
  buttons.push(renderButton({ action: 'history', label: tt('action.history'), busy, variant: 'ghost', data: { slug: c.slug }, icon: 'history' }));
  const actionsHtml = buttons.join('');
  return `<article class="batteries-card" data-slug="${esc(c.slug)}">`
    + `<header class="batteries-card__head"><h3 class="batteries-card__title">${esc(c.label)}</h3>${tagHtml}</header>`
    + `<ul class="batteries-card__items">${itemsHtml}</ul>`
    + `<div class="batteries-actions">${actionsHtml}</div>${panelHtml}</article>`;
}

export function renderPlaces({ places, canWrite, busy, openSlug = null, panelHtml = '' }) {
  const headActionsHtml = canWrite ? renderButton({ action: 'place', label: tt('action.place'), busy, variant: 'primary', icon: 'plus' }) : '';
  const topPanelHtml = openSlug === '' ? panelHtml : '';
  const cardsHtml = places.length
    ? places.map((c) => renderCard(c, { canWrite, busy, panelHtml: c.slug === openSlug ? panelHtml : '' })).join('')
    : renderEmpty({ icon: 'map-pin', title: tt('places.empty.title'), description: tt('places.empty.description') });
  return `<section class="page-section page-measure batteries-places">`
    + `<div class="batteries-section-head"><h2 class="batteries-section-title">${esc(tt('places.title'))}</h2>${headActionsHtml}</div>`
    + `${topPanelHtml}<div class="batteries-cards">${cardsHtml}</div></section>`;
}

// ---------------------------------------------------------------- forms

export function renderPlaceForm({ pools, labels, places, today, busy, values = {} }) {
  const fromOptions = [['', tt('form.from.auto')], ['sin-ubicar', tt('form.from.missing')], ...places.map((c) => [c.slug, c.label])];
  const fieldsHtml = [
    renderField({ label: tt('form.place.label'), controlHtml: `<input class="form-input" name="label" list="batteries-labels" required maxlength="100" autocomplete="off" value="${esc(values.label ?? '')}">`, hint: tt('form.place.hint') }),
    renderField({ label: tt('form.kind'), controlHtml: renderKindSelect('kind', values.kind ?? 'device') }),
    renderField({ label: tt('form.pool'), controlHtml: renderPoolSelect(pools, values.pool_id ?? pools[0]?.id) }),
    renderField({ label: tt('form.quantity'), controlHtml: `<input class="form-input" type="number" name="quantity" min="1" max="1000" required value="${num(values.quantity ?? 1)}">` }),
    renderField({ label: tt('form.from.label'), controlHtml: `<select class="form-input" name="from_slug">${renderOptions(fromOptions, values.from_slug ?? '')}</select>`, hint: tt('form.from.hint') }),
    renderField({ label: tt('form.date'), controlHtml: `<input class="form-input" type="date" name="placed_on" required value="${esc(values.placed_on ?? today)}" max="${esc(today)}">` }),
  ].join('');
  const datalistHtml = renderDatalist('batteries-labels', labels);
  const actionsHtml = renderFormActions({ busy, submitLabel: tt('action.save') });
  return `<form class="batteries-form" data-form="place">${datalistHtml}<h3 class="batteries-form__title">${esc(tt('form.place.title'))}</h3>${fieldsHtml}${actionsHtml}</form>`;
}

export function renderMoveForm({ card, labels = [], busy }) {
  const several = card.items.length > 1;
  const poolsOfPlace = card.items.map((i) => ({ id: i.pool_id, name: i.pool_name }));
  const fieldsHtml = [
    renderField({ label: tt('form.to.label'), controlHtml: `<input class="form-input" name="to_label" list="batteries-labels-move" required maxlength="100" autocomplete="off">`, hint: tt('form.to.hint') }),
    renderField({ label: tt('form.kindNew'), controlHtml: renderKindSelect('kind', 'charger') }),
    several ? renderField({ label: tt('form.pool'), controlHtml: renderPoolSelect(poolsOfPlace, '', { allLabel: tt('form.allPools') }) }) : '',
    renderField({ label: tt('form.quantity'), controlHtml: `<input class="form-input" type="number" name="quantity" min="1" max="1000" placeholder="${esc(tt('form.quantityAll'))}">` }),
  ].join('');
  const datalistHtml = renderDatalist('batteries-labels-move', labels);
  const actionsHtml = renderFormActions({ busy, submitLabel: tt('action.move') });
  return `<form class="batteries-form" data-form="move" data-slug="${esc(card.slug)}">${datalistHtml}${fieldsHtml}${actionsHtml}</form>`;
}

export function renderChangeForm({ card, busy }) {
  const single = card.items.length === 1;
  const oldToHtml = `<select class="form-input" name="old_to">${renderOptions([['charger', tt('form.oldTo.charger')], ['drawer', tt('form.oldTo.drawer')], ['trash', tt('form.oldTo.trash')]], 'charger')}</select>`;
  const fieldsHtml = [
    renderField({ label: tt('form.oldTo.label'), controlHtml: oldToHtml }),
    single ? renderField({ label: tt('form.newQuantity.label'), controlHtml: `<input class="form-input" type="number" name="new_quantity" min="1" max="1000" placeholder="${esc(String(card.items[0].quantity))}">`, hint: tt('form.newQuantity.hint') }) : '',
  ].join('');
  const actionsHtml = renderFormActions({ busy, submitLabel: tt('action.change') });
  return `<form class="batteries-form" data-form="change" data-slug="${esc(card.slug)}"><p class="batteries-form__lead">${esc(tt('form.change.lead'))}</p>${fieldsHtml}${actionsHtml}</form>`;
}

export function renderDiscardForm({ card, busy }) {
  const several = card.items.length > 1;
  const poolsOfPlace = card.items.map((i) => ({ id: i.pool_id, name: i.pool_name }));
  const fieldsHtml = [
    several ? renderField({ label: tt('form.pool'), controlHtml: renderPoolSelect(poolsOfPlace, '', { allLabel: tt('form.allPools') }) }) : '',
    renderField({ label: tt('form.quantity'), controlHtml: `<input class="form-input" type="number" name="quantity" min="1" max="1000" placeholder="${esc(tt('form.quantityAll'))}">` }),
  ].join('');
  const actionsHtml = renderFormActions({ busy, submitLabel: tt('action.discard'), danger: true });
  return `<form class="batteries-form" data-form="discard" data-slug="${esc(card.slug)}"><p class="batteries-form__lead">${esc(tt('form.discard.lead'))}</p>${fieldsHtml}${actionsHtml}</form>`;
}

export function renderFindForm({ pool, labels, today, busy }) {
  const fieldsHtml = [
    renderField({ label: tt('form.quantity'), controlHtml: `<input class="form-input" type="number" name="quantity" min="1" max="${num(pool.breakdown.missing)}" required value="1">` }),
    renderField({ label: tt('form.foundAt'), controlHtml: `<input class="form-input" name="to_label" list="batteries-labels-find" required maxlength="100" autocomplete="off">` }),
    renderField({ label: tt('form.kind'), controlHtml: renderKindSelect('kind', 'drawer') }),
    renderField({ label: tt('form.date'), controlHtml: `<input class="form-input" type="date" name="placed_on" required value="${esc(today)}" max="${esc(today)}">` }),
  ].join('');
  const datalistHtml = renderDatalist('batteries-labels-find', labels);
  const actionsHtml = renderFormActions({ busy, submitLabel: tt('action.find') });
  return `<form class="batteries-form" data-form="find" data-pool="${num(pool.id)}">${datalistHtml}<p class="batteries-form__lead">${esc(tt('form.find.lead', { pool: pool.name }))}</p>${fieldsHtml}${actionsHtml}</form>`;
}

export function renderStockSheet({ pool, busy }) {
  const v = pool ?? {};
  const text = (name, label, value, { required = false, max = 60, placeholder = '' } = {}) => renderField({
    label,
    controlHtml: `<input class="form-input" name="${esc(name)}" maxlength="${num(max)}" autocomplete="off" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}"${flag(required, 'required')}>`,
  });
  const fieldsHtml = [
    text('kind', tt('stock.kind.label'), v.kind, { required: true, max: 20, placeholder: tt('stock.kind.placeholder') }),
    text('brand', tt('stock.brand'), v.brand, { required: true }),
    text('product_line', tt('stock.line.label'), v.product_line, { placeholder: tt('stock.line.placeholder') }),
    renderField({ label: tt('stock.capacity'), controlHtml: `<input class="form-input" type="number" name="capacity_mah" min="1" max="100000" value="${esc(v.capacity_mah ?? '')}">` }),
    renderField({ label: tt('stock.total.label'), controlHtml: `<input class="form-input" type="number" name="total" min="0" max="10000" required value="${num(v.total ?? 0)}">`, hint: pool ? tt('stock.total.hint') : tt('stock.total.hintNew') }),
    text('notes', tt('stock.notes'), v.notes, { max: 500 }),
  ].join('');
  const archiveHtml = pool ? renderButton({ action: 'archive', label: tt('action.archive'), busy, variant: 'ghost', data: { pool: pool.id }, icon: 'archive' }) : '';
  const actionsHtml = renderFormActions({ busy, submitLabel: tt('action.save') });
  const titleHtml = `<h3 class="batteries-form__title">${esc(pool ? tt('stock.editTitle', { pool: pool.name }) : tt('stock.newTitle'))}</h3>`;
  return `<form class="batteries-form" data-form="stock" data-pool="${esc(pool ? pool.id : 'new')}">${titleHtml}${fieldsHtml}${actionsHtml}<div class="batteries-form__extra">${archiveHtml}</div></form>`;
}

export function renderHistory({ card, rows }) {
  const rowsHtml = rows.length
    ? rows.map((r) => {
      const when = new Date(r.created_at).toLocaleString();
      const what = tt('history.row', { n: r.quantity ?? '', from: r.from_label ?? '—', to: r.to_label ?? '—' });
      return `<li class="batteries-history__row"><span class="batteries-history__when">${esc(when)}</span>`
        + `<span class="batteries-history__what">${esc(historyActionName(r.action))}: ${esc(what)}</span>`
        + `<span class="batteries-history__who">${esc(r.actor_name ?? '')} · ${esc(viaName(r.via))}</span></li>`;
    }).join('')
    : `<li class="batteries-history__row">${esc(tt('history.empty'))}</li>`;
  const closeHtml = renderButton({ action: 'cancel', label: tt('action.close'), variant: 'ghost' });
  return `<div class="batteries-history" data-slug="${esc(card.slug)}"><h4 class="batteries-form__title">${esc(tt('history.title'))}</h4><ul>${rowsHtml}</ul>${closeHtml}</div>`;
}
