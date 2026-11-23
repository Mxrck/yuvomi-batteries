// Reading the module's own source for the static checks (escaping, i18n, imports).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const ROOT = new URL('../../modules/batteries/', import.meta.url).pathname;

export function jsFiles(dir = ROOT) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []);
}

export const rel = (file) => relative(ROOT, file);
export const read = (file) => readFileSync(file, 'utf8');
export const readJson = (name) => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));

// Every template literal in `src` (nested ones too) as { raw, exprs, line }: `raw` is the literal
// text with each ${…} replaced by \u0000, `exprs` the expressions in order. A small scanner that
// skips comments and quoted strings; the module avoids regex literals with quotes or backticks.
export function templateLiterals(src) {
  const out = [];
  let i = 0;
  const lineAt = (pos) => src.slice(0, pos).split('\n').length;

  function skipQuoted(q) { // at the opening quote
    i += 1;
    while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
    i += 1;
  }

  function readTemplate() { // at the opening backtick
    const start = i;
    i += 1;
    let raw = '';
    const exprs = [];
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { raw += src.slice(i, i + 2); i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        const exprStart = i;
        let depth = 1;
        while (i < src.length && depth > 0) {
          const ch = src[i];
          if (ch === '`') { readTemplate(); continue; }
          if (ch === '\'' || ch === '"') { skipQuoted(ch); continue; }
          if (ch === '{') depth += 1;
          if (ch === '}') depth -= 1;
          if (depth > 0) i += 1;
        }
        exprs.push(src.slice(exprStart, i).trim());
        i += 1; // the closing }
        raw += '\u0000';
        continue;
      }
      raw += src[i];
      i += 1;
    }
    i += 1; // the closing backtick
    out.push({ raw, exprs, line: lineAt(start) });
  }

  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; if (i < 2) break; continue; }
    if (ch === '\'' || ch === '"') { skipQuoted(ch); continue; }
    if (ch === '`') { readTemplate(); continue; }
    i += 1;
  }
  return out;
}

export const isHtml = (lit) => /<\/?[a-z]/i.test(lit.raw);
