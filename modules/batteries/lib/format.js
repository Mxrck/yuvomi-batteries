// Pure helpers of the page (no DOM, no Yuvomi imports): testable in Node as they are.

// Same normalisation as the sidecar (service/app/time.mjs), so a label typed here finds the place
// the server knows. A test keeps the two identical.
export function slugify(label) {
  return String(label)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Values for the place form from the last use of a known place (implicit template).
export function prefill(labels, text) {
  const slug = slugify(text ?? '');
  if (!slug) return null;
  const hit = (labels ?? []).find((l) => l.slug === slug);
  if (!hit) return null;
  return { label: hit.label, kind: hit.kind, pool_id: hit.last.pool_id, quantity: hit.last.quantity };
}

// [key, params] for "placed N days ago".
export function ageParts(days) {
  if (days <= 0) return ['age.today'];
  if (days === 1) return ['age.one'];
  return ['age.days', { n: days }];
}

// YYYY-MM-DD of the browser's own calendar (the household is where the browser is).
export function todayLocal(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// One id per opened form: a double tap or a retried request repeats it, and the sidecar answers
// the first result instead of writing twice.
export function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
}

// Literal keys (not built from the reason) so the i18n test can check every one of them.
const PLAIN = {
  ambiguous_target: 'error.ambiguous_target',
  pool_exists: 'error.pool_exists',
  allocation_closed: 'error.allocation_closed',
  place_not_found: 'error.place_not_found',
  pool_not_found: 'error.pool_not_found',
  request_id_reused: 'error.request_id_reused',
};

// [key, params] that explains a failed request in the user's language.
export function errorParts(err) {
  const reason = err?.reason;
  const d = err?.details ?? {};
  if (reason === 'stock_exceeded') return ['error.stock_exceeded', { available: d.available ?? d.breakdown?.missing ?? 0 }];
  if (reason === 'insufficient_drawer') return ['error.insufficient_drawer', { needed: d.needed ?? 0, available: d.available ?? 0 }];
  if (reason === 'csrf_invalid' || reason === 'not_authenticated') return ['error.session'];
  if (reason === 'permission_required' || reason === 'family_scope_required') return ['error.permission'];
  if (reason === 'invalid_input') return ['error.invalid_input', { message: err.message ?? '' }];
  if (Object.hasOwn(PLAIN, reason)) return [PLAIN[reason]];
  return ['error.generic', { message: err?.message ?? String(err) }];
}
