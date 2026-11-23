// Pure helpers of the page: same slug as the server, prefill from the last use, dates, errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageParts, errorParts, newRequestId, prefill, slugify, todayLocal } from '../../modules/batteries/lib/format.js';
import { slugify as serverSlugify } from '../../service/app/time.mjs';

test('the page computes exactly the server slug', () => {
  for (const s of ['Tren Thomas de Ángel', '  CONTROL   a/c · recámara ', 'Cajón del niño', 'Sin ubicar', '¿?', 'Ñandú 2']) {
    assert.equal(slugify(s), serverSlugify(s), s);
  }
});

test('prefill from the last use of a known place, matched by slug', () => {
  const labels = [{ slug: 'tren-thomas', label: 'Tren Thomas', kind: 'device', active: false, last: { pool_id: 2, quantity: 3 } }];
  assert.deepEqual(prefill(labels, 'tren  THOMAS'), { label: 'Tren Thomas', kind: 'device', pool_id: 2, quantity: 3 });
  assert.equal(prefill(labels, 'Tren Percy'), null);
  assert.equal(prefill(labels, ''), null);
});

test('age keys and today on the local calendar', () => {
  assert.deepEqual(ageParts(0), ['age.today']);
  assert.deepEqual(ageParts(1), ['age.one']);
  assert.deepEqual(ageParts(12), ['age.days', { n: 12 }]);
  assert.equal(todayLocal(new Date(2026, 10, 23, 23, 30)), '2026-11-23');
  assert.match(newRequestId(), /^[0-9a-f-]{20,}$/);
  assert.notEqual(newRequestId(), newRequestId());
});

test('domain refusals become a translated reason with their numbers; others keep the message', () => {
  assert.deepEqual(errorParts({ reason: 'insufficient_drawer', details: { needed: 3, available: 1 } }), ['error.insufficient_drawer', { needed: 3, available: 1 }]);
  assert.deepEqual(errorParts({ reason: 'stock_exceeded', details: { available: 2 } }), ['error.stock_exceeded', { available: 2 }]);
  assert.deepEqual(errorParts({ reason: 'stock_exceeded', details: { breakdown: { missing: 4 } } }), ['error.stock_exceeded', { available: 4 }]);
  assert.deepEqual(errorParts({ reason: 'csrf_invalid', message: 'x' }), ['error.session']);
  assert.deepEqual(errorParts({ reason: 'permission_required' }), ['error.permission']);
  assert.deepEqual(errorParts({ reason: 'weird', message: 'Boom' }), ['error.generic', { message: 'Boom' }]);
  assert.deepEqual(errorParts(new Error('offline')), ['error.generic', { message: 'offline' }]);
  for (const r of ['ambiguous_target', 'pool_exists', 'allocation_closed', 'place_not_found', 'pool_not_found', 'invalid_input', 'request_id_reused']) {
    assert.equal(errorParts({ reason: r, message: 'm' })[0], `error.${r}`);
  }
});
