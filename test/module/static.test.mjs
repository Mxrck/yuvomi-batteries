// Static checks over the module source (step 25 of the plan and the i18n rule):
//  - no innerHTML / outerHTML / document.write anywhere;
//  - every ${…} inside an HTML template is escaped (esc), numeric (num), a fixed attribute flag
//    (flag), a render…() call or an already rendered …Html fragment;
//  - no hard-coded words between tags or in placeholder/title/aria-label/alt;
//  - only Yuvomi's three stable facades are imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT, isHtml, jsFiles, read, rel, templateLiterals } from './source.mjs';

const ALLOWED_EXPR = [/^esc\(/, /^num\(/, /^flag\(/, /^render[A-Z]\w*\(/, /^\w+Html$/];
const FACADES = new Set(['/api.js', '/i18n.js', '/utils/html.js']);

test('the scanner itself finds what it must (guards the guard)', () => {
  const lits = templateLiterals("const a = 'x`y'; // `no`\nconst b = `<p>${esc(n)} ${`<b>${bad}</b>`}</p>`;");
  assert.equal(lits.length, 2);
  const inner = lits.find((l) => l.exprs.includes('bad'));
  assert.ok(inner && isHtml(inner));
  const outer = lits.find((l) => l.exprs[0] === 'esc(n)');
  assert.ok(outer);
});

test('25 · no innerHTML, outerHTML or document.write in the module', () => {
  for (const file of jsFiles()) {
    const src = read(file);
    for (const banned of [/\.innerHTML\b/, /\.outerHTML\b/, /document\.write\b/]) {
      assert.doesNotMatch(src, banned, `${rel(file)} uses ${banned}`);
    }
  }
});

test('25 · every interpolation inside an HTML template is escaped or already rendered', () => {
  let checked = 0;
  for (const file of jsFiles()) {
    for (const lit of templateLiterals(read(file)).filter(isHtml)) {
      for (const expr of lit.exprs) {
        checked += 1;
        assert.ok(ALLOWED_EXPR.some((re) => re.test(expr)), `${rel(file)}:${lit.line} interpolates \${${expr}} without esc()/num()`);
      }
    }
  }
  assert.ok(checked > 50, `only ${checked} interpolations checked: is the scanner reading the views?`);
});

test('the escaping check really fails on a raw interpolation', () => {
  const lits = templateLiterals('const x = `<span>${label}</span>`;').filter(isHtml);
  assert.equal(ALLOWED_EXPR.some((re) => re.test(lits[0].exprs[0])), false);
});

test('no hard-coded text in HTML templates or in user-facing attributes', () => {
  for (const file of jsFiles()) {
    const src = read(file);
    for (const lit of templateLiterals(src).filter(isHtml)) {
      for (const [, text] of lit.raw.matchAll(/>([^<>]*)</g)) {
        const words = text.replace(/\u0000/g, '').replace(/[\s·×→+\-—:,()/]/g, '');
        assert.equal(words, '', `${rel(file)}:${lit.line} has literal text ${JSON.stringify(text.trim())}`);
      }
      for (const [, attr, value] of lit.raw.matchAll(/\s(placeholder|title|aria-label|alt)="([^"]*)"/g)) {
        assert.equal(value.replace(/\u0000/g, ''), '', `${rel(file)}:${lit.line} ${attr}="${value}" is not translated`);
      }
    }
    assert.doesNotMatch(src, /(textContent|innerText)\s*=\s*['"`][^'"`]*[A-Za-z]/, `${rel(file)} sets literal text`);
    assert.doesNotMatch(src, /\b(confirm|alert|prompt)\(\s*['"`]/, `${rel(file)} shows a literal dialog`);
  }
});

test('the module imports only the stable Yuvomi facades', () => {
  for (const file of jsFiles()) {
    for (const [, spec] of read(file).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      if (spec.startsWith('/')) assert.ok(FACADES.has(spec), `${rel(file)} imports ${spec}`);
      else assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${rel(file)} imports a package: ${spec}`);
    }
  }
});

// Yuvomi's core CSS pads and spaces the page with direct-child selectors
// (`.app-page--data > .app-page__body`), so the module must render straight into the container it
// is given. An extra wrapper div silently removes the page margins against the sidebar and the gap
// between sections; it was a shipped bug once.
test('la página se monta directo en el contenedor, sin envoltorio propio', () => {
  const src = read(join(ROOT, 'index.js'));
  assert.match(src, /const root = container;/);
  assert.doesNotMatch(src, /createElement\('div'\)[^;]*\n\s*root\.className/);
});
