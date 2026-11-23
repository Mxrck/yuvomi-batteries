// Domain of the batteries sidecar: pools of batteries and the places they are in.
//
// A pool ("24 × AAA Duracell Recharge") is split over places: devices, chargers, drawers and
// one "Sin ubicar" (missing) row per pool that the server keeps as total − Σ other places.
// Rule: Σ active places = total, and Sin ubicar never goes negative. Enforced here (so the
// caller gets a useful 409 with the breakdown) and again by triggers in db.mjs.
//
// Every public mutation runs in one synchronous transaction (DatabaseSync, BEGIN IMMEDIATE):
// there is no `await` in this file, so two requests cannot interleave inside a rule check.
// Movements and the idempotency record are written inside the same transaction.
//
// Inputs use the REST field names (snake_case); `ctx` carries who and how:
//   { actorUserId, actorName, via: 'ui'|'mcp', now: Date, tz }
import { DomainError, fail, fromSqlite } from './errors.mjs';
import { HOUSEHOLD_TZ, ageDays, isIsoDate, slugify, todayIn } from './time.mjs';

export const MISSING_SLUG = 'sin-ubicar';
export const MISSING_LABEL = 'Sin ubicar';
const DEFAULT_LABEL = { charger: 'Cargador', drawer: 'Cajón' };
const PLACE_KINDS = ['device', 'charger', 'drawer'];
const KIND_ORDER = { device: 0, charger: 1, drawer: 2, missing: 3 };
const LABEL_MAX = 100;

// ---------------------------------------------------------------- plumbing

function context(ctx = {}) {
  const via = ctx.via ?? 'ui';
  if (via !== 'ui' && via !== 'mcp') fail('invalid_input', 'via must be ui or mcp');
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const tz = ctx.tz || HOUSEHOLD_TZ;
  return {
    actorUserId: Number.isInteger(ctx.actorUserId) ? ctx.actorUserId : null,
    actorName: ctx.actorName ? String(ctx.actorName) : null,
    via, now, tz,
    today: todayIn(tz, now),
    stamp: now.toISOString(),
  };
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw fromSqlite(err);
  }
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// Runs a mutation once per request_id: same operation and payload → the stored result, without
// writing anything; anything else under the same id → request_id_reused.
function mutation(db, operation, input, rawCtx, fn) {
  const c = context(rawCtx);
  const { request_id: requestId, ...payload } = input ?? {};
  if (requestId !== undefined && requestId !== null
      && (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 100)) {
    fail('invalid_input', 'request_id must be a string of 1 to 100 characters');
  }
  return transaction(db, () => {
    const key = stable(payload);
    if (requestId) {
      const prev = db.prepare('SELECT operation, payload, result FROM requests WHERE request_id = ?').get(requestId);
      if (prev) {
        if (prev.operation === operation && prev.payload === key) return JSON.parse(prev.result);
        fail('request_id_reused', 'This request_id was already used for a different request.', { request_id: requestId });
      }
    }
    const result = fn(payload, { ...c, requestId: requestId || null });
    if (requestId) {
      db.prepare('INSERT INTO requests (request_id, operation, payload, result, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(requestId, operation, key, JSON.stringify(result), c.stamp);
    }
    return result;
  });
}

// ---------------------------------------------------------------- validation

function text(value, name, { required = true, max = LABEL_MAX } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) fail('invalid_input', `${name} is required`);
    return null;
  }
  if (typeof value !== 'string') fail('invalid_input', `${name} must be a string`);
  const v = value.trim().replace(/\s+/g, ' ');
  if (v.length > max) fail('invalid_input', `${name} is longer than ${max} characters`);
  return v;
}

function int(value, name, { min = 0, max = 100_000, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('invalid_input', `${name} is required`);
    return null;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('invalid_input', `${name} must be a whole number between ${min} and ${max}`);
  }
  return value;
}

function placeLabel(value, name = 'label') {
  const label = text(value, name);
  const slug = slugify(label);
  if (!slug) fail('invalid_input', `${name} needs at least one letter or digit`);
  return { label, slug };
}

function placeKind(value) {
  if (value === undefined || value === null) return null;
  if (!PLACE_KINDS.includes(value)) fail('invalid_input', `kind must be one of ${PLACE_KINDS.join(', ')}`);
  return value;
}

function placedOn(value, c) {
  if (value === undefined || value === null) return c.today;
  if (!isIsoDate(value)) fail('invalid_input', 'placed_on must be a date YYYY-MM-DD');
  if (value > c.today) fail('invalid_input', 'placed_on cannot be in the future');
  return value;
}

// ---------------------------------------------------------------- reads

function poolName(p) {
  return [p.kind, p.brand, p.product_line, p.capacity_mah ? `${p.capacity_mah} mAh` : null].filter(Boolean).join(' ');
}

function breakdownOf(db, poolId) {
  const out = { device: 0, charger: 0, drawer: 0, missing: 0 };
  for (const r of db.prepare(
    'SELECT kind, SUM(quantity) AS q FROM allocations WHERE pool_id = ? AND closed_on IS NULL GROUP BY kind',
  ).all(poolId)) out[r.kind] = r.q;
  return out;
}

function poolView(db, p) {
  return {
    id: p.id, name: poolName(p), kind: p.kind, brand: p.brand, product_line: p.product_line,
    capacity_mah: p.capacity_mah, total: p.total, notes: p.notes, archived_at: p.archived_at,
    breakdown: breakdownOf(db, p.id),
  };
}

function getPool(db, id) {
  return db.prepare('SELECT * FROM pools WHERE id = ?').get(id);
}

function activePool(db, id) {
  const poolId = int(id, 'pool_id', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const p = getPool(db, poolId);
  if (!p || p.archived_at) fail('pool_not_found', p ? 'This pool is archived.' : 'No such pool.', { pool_id: poolId });
  return p;
}

function activeRow(db, poolId, slug) {
  return db.prepare('SELECT * FROM allocations WHERE pool_id = ? AND slug = ? AND closed_on IS NULL').get(poolId, slug);
}

// Active rows of a place across pools (Sin ubicar excluded), oldest first.
function rowsAt(db, slug) {
  return db.prepare(
    `SELECT a.* FROM allocations a JOIN pools p ON p.id = a.pool_id
      WHERE a.slug = ? AND a.closed_on IS NULL AND a.kind <> 'missing' AND p.archived_at IS NULL
      ORDER BY a.id`,
  ).all(slug);
}

function placeGone(db, slug) {
  const seen = db.prepare('SELECT 1 FROM allocations WHERE slug = ? LIMIT 1').get(slug);
  if (seen) fail('allocation_closed', 'That place has no batteries any more.', { slug });
  fail('place_not_found', 'No such place.', { slug });
}

function candidate(db, row) {
  return { slug: row.slug, label: row.label, kind: row.kind, pool_id: row.pool_id,
    pool_name: poolName(getPool(db, row.pool_id)), quantity: row.quantity };
}

// The kind a place already has wins over the one asked for: a slug means one place.
function kindOfPlace(db, slug, requested) {
  const known = db.prepare(
    `SELECT kind FROM allocations WHERE slug = ? AND kind <> 'missing'
      ORDER BY (closed_on IS NULL) DESC, id DESC LIMIT 1`,
  ).get(slug);
  return known ? known.kind : (requested || 'device');
}

function labelOfPlace(db, slug, fallback) {
  const known = db.prepare(
    'SELECT label FROM allocations WHERE slug = ? ORDER BY (closed_on IS NULL) DESC, id LIMIT 1',
  ).get(slug);
  return known ? known.label : fallback;
}

// ---------------------------------------------------------------- writes

function log(db, c, m) {
  db.prepare(
    `INSERT INTO movements (pool_id, allocation_id, action, quantity, from_label, to_label, from_slug, to_slug,
                            detail, actor_user_id, actor_name, via, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.poolId, m.allocationId ?? null, m.action, m.quantity ?? null, m.from?.label ?? null, m.to?.label ?? null,
    m.from?.slug ?? null, m.to?.slug ?? null, m.detail ? JSON.stringify(m.detail) : null,
    c.actorUserId, c.actorName, c.via, c.requestId ?? null, c.stamp);
}

function closeRow(db, row, reason, c) {
  db.prepare('UPDATE allocations SET closed_on = ?, closed_reason = ? WHERE id = ?').run(c.today, reason, row.id);
}

// Takes `quantity` out of an active row: closes it when it empties, shrinks it otherwise.
function takeFrom(db, row, quantity, reason, c) {
  if (quantity === row.quantity) closeRow(db, row, reason, c);
  else db.prepare('UPDATE allocations SET quantity = quantity - ? WHERE id = ?').run(quantity, row.id);
}

// Adds to the pool's row at that place, or opens one. Returns the row id. A merged row takes the
// date of the latest addition.
function addTo(db, pool, dest, quantity, date, c) {
  const existing = activeRow(db, pool.id, dest.slug);
  if (existing) {
    db.prepare('UPDATE allocations SET quantity = quantity + ?, placed_on = ? WHERE id = ?').run(quantity, date, existing.id);
    return existing.id;
  }
  return Number(db.prepare(
    `INSERT INTO allocations (pool_id, kind, label, slug, quantity, placed_on, request_id,
                              created_by_user_id, created_by_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(pool.id, dest.kind, dest.label, dest.slug, quantity, date, c.requestId ?? null,
    c.actorUserId, c.actorName, c.stamp).lastInsertRowid);
}

// Sin ubicar = total − Σ other active places, rewritten after every mutation.
function recomputeMissing(db, poolId, c) {
  const pool = getPool(db, poolId);
  const placed = db.prepare(
    "SELECT IFNULL(SUM(quantity), 0) AS s FROM allocations WHERE pool_id = ? AND closed_on IS NULL AND kind <> 'missing'",
  ).get(poolId).s;
  const missing = pool.total - placed;
  if (missing < 0) {
    fail('stock_exceeded', 'The places would hold more batteries than the pool total.',
      { pool_id: poolId, total: pool.total, breakdown: breakdownOf(db, poolId) });
  }
  const row = db.prepare("SELECT * FROM allocations WHERE pool_id = ? AND kind = 'missing' AND closed_on IS NULL").get(poolId);
  if (missing === 0) {
    if (row) closeRow(db, row, 'moved', c);
  } else if (row) {
    if (row.quantity !== missing) db.prepare('UPDATE allocations SET quantity = ? WHERE id = ?').run(missing, row.id);
  } else {
    db.prepare(
      `INSERT INTO allocations (pool_id, kind, label, slug, quantity, placed_on, created_at)
       VALUES (?, 'missing', ?, ?, ?, ?, ?)`,
    ).run(poolId, MISSING_LABEL, MISSING_SLUG, missing, c.today, c.stamp);
  }
}

function stockExceeded(db, pool, extra = {}) {
  fail('stock_exceeded', 'Not that many batteries there.',
    { pool_id: pool.id, total: pool.total, breakdown: breakdownOf(db, pool.id), ...extra });
}

const MISSING_PLACE = { slug: MISSING_SLUG, label: MISSING_LABEL, kind: 'missing' };

// The one primitive: `quantity` batteries of one pool from one place to another. Poner, mover,
// encontrar and both halves of cambiar pilas are this. Moving to Sin ubicar is losing them.
function move(db, { poolId, fromSlug, toLabel, kind, quantity, date, action, role }, c) {
  const pool = activePool(db, poolId);
  const to = placeLabel(toLabel, 'to_label');
  if (to.slug === fromSlug) fail('invalid_input', 'Origin and destination are the same place.');

  let from;
  if (fromSlug === MISSING_SLUG) {
    from = MISSING_PLACE;
    const missing = breakdownOf(db, pool.id).missing;
    if (quantity > missing) stockExceeded(db, pool, { available: missing });
  } else {
    const row = activeRow(db, pool.id, fromSlug);
    if (!row) placeGone(db, fromSlug);
    from = { slug: row.slug, label: row.label, kind: row.kind };
    if (quantity > row.quantity) stockExceeded(db, pool, { available: row.quantity, slug: row.slug });
    takeFrom(db, row, quantity, 'moved', c); // out first, so the trigger never sees them twice
  }

  let dest = MISSING_PLACE;
  let allocationId = null;
  if (to.slug !== MISSING_SLUG) {
    dest = { slug: to.slug, label: labelOfPlace(db, to.slug, to.label), kind: kindOfPlace(db, to.slug, kind) };
    allocationId = addTo(db, pool, dest, quantity, date ?? c.today, c);
  }
  recomputeMissing(db, pool.id, c);
  log(db, c, { poolId: pool.id, allocationId, action, quantity, from, to: dest, detail: role ? { role } : null });
  const leg = { pool_id: pool.id, pool_name: poolName(pool), quantity, from, to: dest };
  return role ? { role, ...leg } : leg;
}

// Where a placement comes from when the caller does not say: the pool's drawer if it has one,
// Sin ubicar if it has none. A drawer that is too short is reported, never topped up silently.
function defaultSource(db, pool, quantity) {
  const drawers = db.prepare(
    "SELECT * FROM allocations WHERE pool_id = ? AND kind = 'drawer' AND closed_on IS NULL ORDER BY id",
  ).all(pool.id);
  if (drawers.length === 0) return MISSING_SLUG;
  if (drawers.length > 1) {
    fail('ambiguous_target', 'Several drawers hold this pool; say which one.', { candidates: drawers.map((r) => candidate(db, r)) });
  }
  if (drawers[0].quantity < quantity) {
    fail('insufficient_drawer', 'The drawer does not have that many.', { pool_id: pool.id, needed: quantity, available: drawers[0].quantity });
  }
  return drawers[0].slug;
}

// The house's charger or drawer for "old ones go to …": the only active one, else the last one
// used, else a new one with the default name. Two active ones are ambiguous.
function houseSlot(db, kind) {
  const active = db.prepare(
    `SELECT DISTINCT a.slug, a.label FROM allocations a JOIN pools p ON p.id = a.pool_id
      WHERE a.kind = ? AND a.closed_on IS NULL AND p.archived_at IS NULL ORDER BY a.slug`,
  ).all(kind);
  const slugs = [...new Map(active.map((r) => [r.slug, r])).values()];
  if (slugs.length > 1) {
    fail('ambiguous_target', `Several ${kind === 'charger' ? 'chargers' : 'drawers'}; say which one.`,
      { candidates: slugs.map((r) => ({ slug: r.slug, label: r.label, kind })) });
  }
  if (slugs.length === 1) return labelOfPlace(db, slugs[0].slug, slugs[0].label);
  const last = db.prepare('SELECT label FROM allocations WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind);
  return last ? last.label : DEFAULT_LABEL[kind];
}

// ---------------------------------------------------------------- pools

function checkIdentityFree(db, fields, exceptId = null) {
  const hit = db.prepare(
    `SELECT id FROM pools WHERE archived_at IS NULL AND id IS NOT ?
       AND lower(trim(kind)) = lower(trim(?)) AND lower(trim(brand)) = lower(trim(?))
       AND lower(trim(IFNULL(product_line, ''))) = lower(trim(IFNULL(?, '')))
       AND IFNULL(capacity_mah, 0) = IFNULL(?, 0)`,
  ).get(exceptId, fields.kind, fields.brand, fields.product_line, fields.capacity_mah);
  if (hit) fail('pool_exists', 'A pool with the same type, brand, line and capacity already exists.', { pool_id: hit.id });
}

export function createPool(db, input, ctx) {
  return mutation(db, 'createPool', input, ctx, (p, c) => {
    const fields = {
      kind: text(p.kind, 'kind', { max: 20 }).toUpperCase(),
      brand: text(p.brand, 'brand', { max: 60 }),
      product_line: text(p.product_line, 'product_line', { required: false, max: 60 }),
      capacity_mah: int(p.capacity_mah, 'capacity_mah', { min: 1, max: 100_000, required: false }),
      total: int(p.total, 'total', { min: 0, max: 10_000 }),
      notes: text(p.notes, 'notes', { required: false, max: 500 }),
    };
    checkIdentityFree(db, fields);
    const id = Number(db.prepare(
      `INSERT INTO pools (kind, brand, product_line, capacity_mah, total, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(fields.kind, fields.brand, fields.product_line, fields.capacity_mah, fields.total, fields.notes, c.stamp).lastInsertRowid);
    recomputeMissing(db, id, c);
    log(db, c, { poolId: id, action: 'pool_created', quantity: fields.total, detail: fields });
    return poolView(db, getPool(db, id));
  });
}

export function updatePool(db, input, ctx) {
  return mutation(db, 'updatePool', input, ctx, (p, c) => {
    const pool = activePool(db, p.pool_id);
    const next = { ...pool };
    if ('kind' in p) next.kind = text(p.kind, 'kind', { max: 20 }).toUpperCase();
    if ('brand' in p) next.brand = text(p.brand, 'brand', { max: 60 });
    if ('product_line' in p) next.product_line = text(p.product_line, 'product_line', { required: false, max: 60 });
    if ('capacity_mah' in p) next.capacity_mah = int(p.capacity_mah, 'capacity_mah', { min: 1, max: 100_000, required: false });
    if ('notes' in p) next.notes = text(p.notes, 'notes', { required: false, max: 500 });
    if ('total' in p) next.total = int(p.total, 'total', { min: 0, max: 10_000 });

    const b = breakdownOf(db, pool.id);
    const placed = b.device + b.charger + b.drawer;
    if (next.total < placed) {
      fail('stock_exceeded', `${placed} batteries are in known places; the total cannot go below that.`,
        { pool_id: pool.id, total: pool.total, requested_total: next.total, breakdown: b });
    }
    checkIdentityFree(db, next, pool.id);
    db.prepare('UPDATE pools SET kind = ?, brand = ?, product_line = ?, capacity_mah = ?, notes = ?, total = ? WHERE id = ?')
      .run(next.kind, next.brand, next.product_line, next.capacity_mah, next.notes, next.total, pool.id);
    recomputeMissing(db, pool.id, c);
    const changes = {};
    for (const k of ['kind', 'brand', 'product_line', 'capacity_mah', 'notes', 'total']) {
      if (next[k] !== pool[k]) changes[k] = { from: pool[k], to: next[k] };
    }
    log(db, c, { poolId: pool.id, action: 'pool_adjusted', quantity: next.total - pool.total, detail: changes });
    return poolView(db, getPool(db, pool.id));
  });
}

// Archiving closes every place of the pool (kept as history) and frees its identity.
export function archivePool(db, input, ctx) {
  return mutation(db, 'archivePool', input, ctx, (p, c) => {
    const pool = activePool(db, p.pool_id);
    for (const row of db.prepare('SELECT * FROM allocations WHERE pool_id = ? AND closed_on IS NULL').all(pool.id)) {
      closeRow(db, row, 'moved', c);
    }
    db.prepare('UPDATE pools SET archived_at = ? WHERE id = ?').run(c.stamp, pool.id);
    log(db, c, { poolId: pool.id, action: 'pool_archived', quantity: pool.total });
    return poolView(db, getPool(db, pool.id));
  });
}

// ---------------------------------------------------------------- places

function result(db, operation, legs) {
  const ids = [...new Set(legs.map((l) => l.pool_id))];
  return { operation, legs, pools: ids.map((id) => poolView(db, getPool(db, id))) };
}

// Poner: batteries of a pool into a place; without from_slug, see the source rule below.
export function place(db, input, ctx) {
  return mutation(db, 'place', input, ctx, (p, c) => {
    const pool = activePool(db, p.pool_id);
    const to = placeLabel(p.label);
    if (to.slug === MISSING_SLUG) fail('invalid_input', `"${MISSING_LABEL}" is kept by the server; use move to lose batteries.`);
    const kind = placeKind(p.kind);
    const quantity = int(p.quantity, 'quantity', { min: 1 });
    const date = placedOn(p.placed_on, c);
    // Into a device, charged ones come out of the drawer. Into a charger or drawer, poner is
    // registering batteries found there, so they come out of Sin ubicar.
    const destKind = kindOfPlace(db, to.slug, kind);
    let fromSlug;
    if (p.from_slug !== undefined && p.from_slug !== null) fromSlug = placeLabel(p.from_slug, 'from_slug').slug;
    else fromSlug = destKind === 'device' ? defaultSource(db, pool, quantity) : MISSING_SLUG;
    const leg = move(db, { poolId: pool.id, fromSlug, toLabel: to.label, kind, quantity, date, action: 'placed' }, c);
    return result(db, 'place', [leg]);
  });
}

// Mover: from one place to another, partially with `quantity`, or the whole place without it.
export function moveTo(db, input, ctx) {
  return mutation(db, 'move', input, ctx, (p, c) => {
    const from = placeLabel(p.from_slug, 'from_slug');
    placeLabel(p.to_label, 'to_label');
    const kind = placeKind(p.kind);
    const quantity = int(p.quantity, 'quantity', { min: 1, required: false });
    if (from.slug === MISSING_SLUG) {
      // Out of Sin ubicar is "encontrar": one pool, an explicit quantity.
      const pool = activePool(db, p.pool_id);
      const q = quantity ?? fail('invalid_input', 'quantity is required to move out of Sin ubicar');
      return result(db, 'move', [move(db, { poolId: pool.id, fromSlug: MISSING_SLUG, toLabel: p.to_label, kind, quantity: q, action: 'found' }, c)]);
    }
    let rows = rowsAt(db, from.slug);
    if (p.pool_id !== undefined && p.pool_id !== null) rows = rows.filter((r) => r.pool_id === p.pool_id);
    if (rows.length === 0) placeGone(db, from.slug);
    if (quantity !== null && rows.length > 1) {
      fail('ambiguous_target', 'That place holds several pools; say which one.', { candidates: rows.map((r) => candidate(db, r)) });
    }
    const legs = rows.map((r) => move(db, {
      poolId: r.pool_id, fromSlug: from.slug, toLabel: p.to_label, kind, quantity: quantity ?? r.quantity, action: 'moved',
    }, c));
    return result(db, 'move', legs);
  });
}

// Encontrar: out of Sin ubicar into the place where they turned up.
export function find(db, input, ctx) {
  return mutation(db, 'find', input, ctx, (p, c) => {
    const pool = activePool(db, p.pool_id);
    const to = placeLabel(p.to_label, 'to_label');
    if (to.slug === MISSING_SLUG) fail('invalid_input', 'Found batteries go to a real place.');
    const quantity = int(p.quantity, 'quantity', { min: 1 });
    const date = placedOn(p.placed_on, c);
    const leg = move(db, { poolId: pool.id, fromSlug: MISSING_SLUG, toLabel: to.label, kind: placeKind(p.kind), quantity, date, action: 'found' }, c);
    return result(db, 'find', [leg]);
  });
}

// Cambiar pilas, all or nothing: the device's batteries go to the charger, the drawer or the
// trash, and the same number (or new_quantity of new_pool_id) come out of the drawer, dated today.
export function change(db, input, ctx) {
  return mutation(db, 'change', input, ctx, (p, c) => {
    const at = placeLabel(p.label ?? p.slug);
    if (!['charger', 'drawer', 'trash'].includes(p.old_to)) fail('invalid_input', 'old_to must be charger, drawer or trash');
    const rows = rowsAt(db, at.slug);
    if (rows.length === 0) placeGone(db, at.slug);
    if (rows.some((r) => r.kind !== 'device')) fail('invalid_input', 'Only a device has its batteries changed; use move for other places.');
    const override = (p.new_pool_id ?? null) !== null || (p.new_quantity ?? null) !== null;
    if (override && rows.length > 1) {
      fail('ambiguous_target', 'That device holds several pools; change them one by one or without new_pool_id/new_quantity.',
        { candidates: rows.map((r) => candidate(db, r)) });
    }
    const newQty = int(p.new_quantity, 'new_quantity', { min: 1, required: false });
    const deviceLabel = rows[0].label;

    // 1. Plan the new ones and check every drawer before writing anything.
    const plan = rows.map((r) => ({ pool: activePool(db, p.new_pool_id ?? r.pool_id), quantity: newQty ?? r.quantity }));
    const demand = new Map();
    for (const n of plan) demand.set(n.pool.id, (demand.get(n.pool.id) ?? 0) + n.quantity);
    const drawerOf = new Map();
    for (const [poolId, needed] of demand) {
      const drawers = db.prepare(
        "SELECT * FROM allocations WHERE pool_id = ? AND kind = 'drawer' AND closed_on IS NULL ORDER BY id",
      ).all(poolId);
      if (drawers.length > 1) {
        fail('ambiguous_target', 'Several drawers hold this pool; move the new ones by hand.', { candidates: drawers.map((r) => candidate(db, r)) });
      }
      const available = drawers[0]?.quantity ?? 0;
      if (available < needed) fail('insufficient_drawer', 'The drawer does not have enough for the change.', { pool_id: poolId, needed, available });
      drawerOf.set(poolId, drawers[0].slug);
    }

    // 2. Old ones out. 3. New ones in. One transaction: a refusal anywhere undoes both.
    const legs = [];
    const slotLabel = p.old_to === 'trash' ? null : houseSlot(db, p.old_to);
    for (const r of rows) {
      if (p.old_to === 'trash') {
        const pool = getPool(db, r.pool_id);
        takeFrom(db, r, r.quantity, 'discarded', c);
        db.prepare('UPDATE pools SET total = total - ? WHERE id = ?').run(r.quantity, pool.id);
        recomputeMissing(db, pool.id, c);
        const from = { slug: r.slug, label: r.label, kind: r.kind };
        log(db, c, { poolId: pool.id, allocationId: r.id, action: 'changed', quantity: r.quantity, from, detail: { role: 'old', to: 'trash' } });
        legs.push({ role: 'old', pool_id: pool.id, pool_name: poolName(pool), quantity: r.quantity, from, to: null });
      } else {
        legs.push(move(db, { poolId: r.pool_id, fromSlug: at.slug, toLabel: slotLabel, kind: p.old_to, quantity: r.quantity, action: 'changed', role: 'old' }, c));
      }
    }
    for (const n of plan) {
      legs.push(move(db, { poolId: n.pool.id, fromSlug: drawerOf.get(n.pool.id), toLabel: deviceLabel, kind: 'device', quantity: n.quantity, action: 'changed', role: 'new' }, c));
    }
    return result(db, 'change', legs);
  });
}

// Desechar: they are dead. Closes (part of) a place and lowers the pool total by as many.
export function discard(db, input, ctx) {
  return mutation(db, 'discard', input, ctx, (p, c) => {
    const at = placeLabel(p.slug ?? p.label, 'slug');
    const quantity = int(p.quantity, 'quantity', { min: 1, required: false });
    if (at.slug === MISSING_SLUG) {
      const pool = activePool(db, p.pool_id);
      const missing = breakdownOf(db, pool.id).missing;
      const q = quantity ?? missing;
      if (q < 1 || q > missing) stockExceeded(db, pool, { available: missing });
      db.prepare('UPDATE pools SET total = total - ? WHERE id = ?').run(q, pool.id);
      recomputeMissing(db, pool.id, c);
      log(db, c, { poolId: pool.id, action: 'discarded', quantity: q, from: MISSING_PLACE });
      return result(db, 'discard', [{ pool_id: pool.id, pool_name: poolName(pool), quantity: q, from: MISSING_PLACE, to: null }]);
    }
    let rows = rowsAt(db, at.slug);
    if (p.pool_id !== undefined && p.pool_id !== null) rows = rows.filter((r) => r.pool_id === p.pool_id);
    if (rows.length === 0) placeGone(db, at.slug);
    if (quantity !== null && rows.length > 1) {
      fail('ambiguous_target', 'That place holds several pools; say which one.', { candidates: rows.map((r) => candidate(db, r)) });
    }
    const legs = [];
    for (const r of rows) {
      const pool = getPool(db, r.pool_id);
      const q = quantity ?? r.quantity;
      if (q > r.quantity) stockExceeded(db, pool, { available: r.quantity, slug: r.slug });
      takeFrom(db, r, q, 'discarded', c); // out of the place first, then the total can drop
      db.prepare('UPDATE pools SET total = total - ? WHERE id = ?').run(q, pool.id);
      recomputeMissing(db, pool.id, c);
      const from = { slug: r.slug, label: r.label, kind: r.kind };
      log(db, c, { poolId: pool.id, allocationId: r.id, action: 'discarded', quantity: q, from });
      legs.push({ pool_id: pool.id, pool_name: poolName(pool), quantity: q, from, to: null });
    }
    return result(db, 'discard', legs);
  });
}

// ---------------------------------------------------------------- read models

export function summary(db, { include_archived: includeArchived = false } = {}) {
  const pools = db.prepare(
    `SELECT * FROM pools ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY id`,
  ).all();
  return pools.map((p) => poolView(db, p));
}

// Places as cards: one per slug, with one item per pool it holds.
export function placesList(db, { now = new Date(), tz = HOUSEHOLD_TZ, include_missing: includeMissing = false } = {}) {
  const rows = db.prepare(
    `SELECT a.*, p.kind AS p_kind, p.brand, p.product_line, p.capacity_mah
       FROM allocations a JOIN pools p ON p.id = a.pool_id
      WHERE a.closed_on IS NULL AND p.archived_at IS NULL ${includeMissing ? '' : "AND a.kind <> 'missing'"}
      ORDER BY a.id`,
  ).all();
  const cards = new Map();
  for (const r of rows) {
    // Sin ubicar is one per pool; as cards they stay apart.
    const key = r.kind === 'missing' ? `${r.slug}#${r.pool_id}` : r.slug;
    if (!cards.has(key)) cards.set(key, { slug: r.slug, label: r.label, kind: r.kind, items: [] });
    cards.get(key).items.push({
      allocation_id: r.id, pool_id: r.pool_id,
      pool_name: poolName({ kind: r.p_kind, brand: r.brand, product_line: r.product_line, capacity_mah: r.capacity_mah }),
      quantity: r.quantity, placed_on: r.placed_on, age_days: ageDays(r.placed_on, tz, now),
      checked_on: r.checked_on, notes: r.notes,
    });
  }
  return [...cards.values()].sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.label.localeCompare(b.label, 'es'));
}

export function placeHistory(db, { slug, limit = 100 } = {}) {
  const s = placeLabel(slug, 'slug').slug;
  const n = int(limit, 'limit', { min: 1, max: 500 });
  return db.prepare(
    `SELECT id, pool_id, allocation_id, action, quantity, from_label, to_label, from_slug, to_slug, detail,
            actor_user_id, actor_name, via, created_at
       FROM movements WHERE from_slug = ? OR to_slug = ? ORDER BY id DESC LIMIT ?`,
  ).all(s, s, n).map((m) => ({ ...m, detail: m.detail ? JSON.parse(m.detail) : null }));
}

export { DomainError };
