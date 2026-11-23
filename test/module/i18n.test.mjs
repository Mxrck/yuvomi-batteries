// Locales: en and es carry the same keys and placeholders, every key the JS asks for exists,
// every shipped key is used, and the manifest's label keys are there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jsFiles, read, readJson, rel } from './source.mjs';

const en = readJson('locales/en.json');
const es = readJson('locales/es.json');
const manifest = readJson('module.json');
const placeholders = (s) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

// Keys come from tt('…') calls and from key literals handed to tt() later (format.js returns
// ['error.x', params] pairs). Both kinds must exist in the locales.
const KEY_LITERAL = /'((?:age|error|kind|history|pool|pools|places|form|action|notice|stock|title|readOnly|noAccess)(?:\.[\w-]+)*)'/g;

function usedKeys() {
  const keys = new Map();
  for (const file of jsFiles()) {
    const src = read(file);
    for (const [, key] of src.matchAll(/\btt\(\s*'([^']+)'/g)) keys.set(key, rel(file));
    for (const [, key] of src.matchAll(KEY_LITERAL)) if (key.includes('.') || Object.hasOwn(en, key)) keys.set(key, rel(file));
    assert.doesNotMatch(src, /\btt\(\s*[`"]/, `${rel(file)}: tt() keys must be plain '…' literals so they can be checked`);
  }
  return keys;
}

test('en and es have the same keys, all non-empty strings, with the same placeholders', () => {
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    for (const [name, dict] of [['en', en], ['es', es]]) {
      assert.equal(typeof dict[key], 'string', `${name}.${key}`);
      assert.ok(dict[key].trim().length > 0, `${name}.${key} is empty`);
    }
    assert.deepEqual(placeholders(es[key]), placeholders(en[key]), `placeholders differ in ${key}`);
  }
});

// Yuvomi nests flat locale keys by their dots (nestFlatLocaleDict in /i18n.js, 2.94.0): with
// "form.from" and "form.from.auto" both present one of them silently replaces the other.
test('no locale key is a dotted prefix of another', () => {
  const keys = Object.keys(en);
  for (const a of keys) {
    for (const b of keys) assert.ok(!b.startsWith(`${a}.`), `"${a}" would be lost under "${b}"`);
  }
});

test('every key the module asks for exists, and every shipped key is used', () => {
  const used = usedKeys();
  for (const [key, file] of used) assert.ok(Object.hasOwn(en, key), `${file} uses missing key ${key}`);
  const reserved = new Set(['menu', 'module']); // read by Yuvomi from the manifest, not by tt()
  for (const key of Object.keys(en)) {
    assert.ok(used.has(key) || reserved.has(key), `locale key ${key} is never used`);
  }
});

// tt('key', { a, b: x }) and ['key', { a }] pairs: the names passed must be the placeholders.
test('the parameters the code passes are exactly the placeholders of each key', () => {
  const names = (obj) => obj.split(',').map((p) => p.split(':')[0].trim()).filter(Boolean).sort();
  let checked = 0;
  for (const file of jsFiles()) {
    const src = read(file);
    for (const re of [/\btt\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/g, /\[\s*'([^']+)'\s*,\s*\{([^}]*)\}\s*\]/g]) {
      for (const [, key, obj] of src.matchAll(re)) {
        if (!Object.hasOwn(en, key)) continue; // reported by the key test
        checked += 1;
        assert.deepEqual(names(obj), placeholders(en[key]), `${rel(file)}: ${key} gets {${names(obj)}} but expects {${placeholders(en[key])}}`);
      }
    }
  }
  assert.ok(checked >= 8, `only ${checked} parameterised keys found`);
});

test('module.json label keys and the mandatory menu/module keys exist', () => {
  for (const key of ['menu', 'module']) assert.ok(en[key] && es[key], `missing ${key}`);
  assert.equal(manifest.menu.labelKey, 'menu');
  assert.equal(manifest.capabilities.permissions.module.labelKey, 'module');
});

test('the manifest follows the plan and the package version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.id, 'batteries');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.entry, 'index.js');
  assert.equal(manifest.i18n.defaultLocale, 'en');
  assert.equal(manifest.capabilities.api.prefix, '/api/extensions/batteries');
  assert.deepEqual(manifest.capabilities.permissions.module, { labelKey: 'module', icon: 'battery' });
});
