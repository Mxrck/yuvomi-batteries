// Calendar dates of the household and label slugs. Pure functions, no I/O.

// The household calendar. Deliberately not process.env.TZ: the answer must not depend on the
// machine the code runs on (tests run in UTC, the container may too).
export const HOUSEHOLD_TZ = process.env.HOUSEHOLD_TZ || 'America/Merida';

const formatters = new Map();

// YYYY-MM-DD of `now` on the calendar of `tz`.
export function todayIn(tz = HOUSEHOLD_TZ, now = new Date()) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(tz, f);
  }
  return f.format(now); // en-CA formats as 2026-11-23
}

function dayNumber(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

// Whole calendar days between `isoDate` and today in `tz` (0 = today).
export function ageDays(isoDate, tz = HOUSEHOLD_TZ, now = new Date()) {
  return dayNumber(todayIn(tz, now)) - dayNumber(isoDate);
}

export function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// Stable key of a place label: "Tren Thomas de Ángel" → "tren-thomas-de-angel".
export function slugify(label) {
  return String(label)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
