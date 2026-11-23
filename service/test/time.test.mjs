import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageDays, isIsoDate, slugify, todayIn } from '../app/time.mjs';

test('slug is stable: lower case, no accents, dashes', () => {
  assert.equal(slugify('Tren Thomas de Ángel'), 'tren-thomas-de-angel');
  assert.equal(slugify('  tren   THOMAS de angel '), 'tren-thomas-de-angel');
  assert.equal(slugify('Control A/C · recámara (principal)'), 'control-a-c-recamara-principal');
  assert.equal(slugify('Cajón del niño'), 'cajon-del-nino');
  assert.equal(slugify('¿?'), '');
});

test('age_days crosses midnight on the America/Merida calendar, not UTC', () => {
  const tz = 'America/Merida';
  // 23:30 on the 23rd in Mérida is already the 24th in UTC.
  const lateEvening = new Date('2026-11-24T05:30:00Z');
  assert.equal(todayIn(tz, lateEvening), '2026-11-23');
  assert.equal(ageDays('2026-11-22', tz, lateEvening), 1);
  assert.equal(ageDays('2026-11-23', tz, lateEvening), 0);
  // One hour later it is 00:30 on the 24th in Mérida.
  const afterMidnight = new Date('2026-11-24T06:30:00Z');
  assert.equal(todayIn(tz, afterMidnight), '2026-11-24');
  assert.equal(ageDays('2026-11-22', tz, afterMidnight), 2);
  // Long spans are whole calendar days.
  assert.equal(ageDays('2025-11-24', tz, afterMidnight), 365);
});

test('isIsoDate accepts real calendar days only', () => {
  assert.ok(isIsoDate('2026-11-12'));
  assert.ok(isIsoDate('2024-02-29'));
  assert.ok(!isIsoDate('2026-02-30'));
  assert.ok(!isIsoDate('12/11/2026'));
  assert.ok(!isIsoDate('2026-11-12T00:00'));
});
