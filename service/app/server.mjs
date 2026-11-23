// HTTP front of the batteries sidecar: REST under /api/extensions/batteries plus the MCP
// endpoint at …/mcp, on node:http only. Environment (when run as a program):
//   PORT                 listen port (default 3100)
//   DB_PATH              SQLite file (default /data/batteries.db)
//   YUVOMI_INTERNAL_URL  where this service reaches Yuvomi (required)
//   PUBLIC_ORIGIN        the origin browsers use for Yuvomi (required; exact Origin for cookie writes)
//   HOUSEHOLD_TZ         calendar of the household (default America/Merida)
//
// Order for every request except /health: credential → /auth/me → permission → CSRF → route.
// An unauthenticated caller therefore learns nothing about the routes (401 before 404).
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { closeDb, openDb, SCHEMA_VERSION } from './db.mjs';
import { createAuth } from './auth.mjs';
import { DomainError } from './errors.mjs';
import { humanize } from './humanize.mjs';
import { handleMcp } from './mcp.mjs';
import {
  archivePool, change, createPool, discard, find, moveTo, place, placeHistory, placesList, summary, updatePool,
} from './places.mjs';

export const PREFIX = '/api/extensions/batteries';
export const VERSION = '0.1.0';
const BODY_LIMIT = 64 * 1024;

const httpError = (code, reason, message) => new DomainError(code, reason, message);
const flag = (v) => v === '1' || v === 'true';

function send(res, status, body, extra = {}) {
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra };
  if (body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

// Reads a JSON body. Over the limit it keeps draining (so the client can read the 413) but
// stops accumulating.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) over = true;
      else chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (over) return reject(httpError(413, 'payload_too_large', `Body larger than ${BODY_LIMIT} bytes.`));
      if (size === 0) return resolve({});
      if (type !== 'application/json') return reject(httpError(415, 'unsupported_media_type', 'Send application/json.'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'invalid_json', 'The body is not valid JSON.'));
      }
    });
  });
}

function exportAll(db) {
  const all = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
  return {
    exported_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
    pools: all('SELECT * FROM pools ORDER BY id'),
    allocations: all('SELECT * FROM allocations ORDER BY id'),
    movements: all('SELECT * FROM movements ORDER BY id'),
  };
}

// [method, pattern, handler(ctx) → { status?, data, operation? }]
function routes() {
  const mutate = (operation, fn) => (x) => {
    const result = fn(x);
    return { data: result, operation };
  };
  return [
    ['GET', /^\/summary$/, ({ db, url }) => ({ data: summary(db, { include_archived: flag(url.searchParams.get('include_archived')) }) })],
    ['POST', /^\/pools$/, (x) => ({ status: 201, ...mutate('createPool', ({ db, body, ctx }) => createPool(db, body, ctx))(x) })],
    ['PATCH', /^\/pools\/(\d+)$/, mutate('updatePool', ({ db, body, ctx, m }) => updatePool(db, { ...body, pool_id: Number(m[1]) }, ctx))],
    ['POST', /^\/pools\/(\d+)\/archive$/, mutate('archivePool', ({ db, body, ctx, m }) => archivePool(db, { request_id: body.request_id, pool_id: Number(m[1]) }, ctx))],
    ['GET', /^\/places$/, ({ db, url }) => {
      const state = url.searchParams.get('state') ?? 'active';
      if (state !== 'active') throw httpError(400, 'invalid_input', 'Only state=active is supported.');
      return { data: placesList(db, { include_missing: flag(url.searchParams.get('include_missing')) }) };
    }],
    ['POST', /^\/places\/place$/, mutate('place', ({ db, body, ctx }) => place(db, body, ctx))],
    ['POST', /^\/places\/move$/, mutate('move', ({ db, body, ctx }) => moveTo(db, body, ctx))],
    ['POST', /^\/places\/find$/, mutate('find', ({ db, body, ctx }) => find(db, body, ctx))],
    ['POST', /^\/places\/change$/, mutate('change', ({ db, body, ctx }) => change(db, body, ctx))],
    ['POST', /^\/places\/discard$/, mutate('discard', ({ db, body, ctx }) => discard(db, body, ctx))],
    ['GET', /^\/places\/([^/]+)\/history$/, ({ db, url, m }) => {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100;
      return { data: placeHistory(db, { slug: decodeURIComponent(m[1]), limit }) };
    }],
    ['GET', /^\/export$/, ({ db }) => ({ data: exportAll(db) })],
  ];
}

export function createApp({ db, auth, prefix = PREFIX, log = () => {} }) {
  const table = routes();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      throw httpError(404, 'not_found', 'Not found.');
    }
    const path = url.pathname.slice(prefix.length) || '/';
    if (path === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'method_not_allowed', 'Use GET.');
      return send(res, 200, { ok: true });
    }

    const identity = await auth.resolve(req);
    // Everything after this await is synchronous: the domain never awaits inside a transaction.

    if (path === '/mcp') {
      if (req.method !== 'POST') {
        return send(res, 405, { error: 'Use POST (no SSE stream on this server).', code: 405, reason: 'method_not_allowed' }, { allow: 'POST' });
      }
      auth.authorize(identity, 'read'); // per-tool write checks happen in mcp.mjs
      auth.assertCsrf(req, identity);
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        if (err.reason === 'invalid_json') return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        throw err;
      }
      const out = handleMcp(db, identity, auth, body, { version: VERSION });
      return send(res, out.status, out.body);
    }

    const sameRoute = table.filter(([, re]) => re.test(path));
    const route = sameRoute.find(([method]) => method === req.method);
    if (!route) {
      if (sameRoute.length) {
        throw Object.assign(httpError(405, 'method_not_allowed', 'Method not allowed.'), { allow: sameRoute.map(([mth]) => mth).join(', ') });
      }
      throw httpError(404, 'not_found', 'Not found.');
    }
    auth.authorize(identity, req.method);
    auth.assertCsrf(req, identity);
    const body = req.method === 'GET' ? {} : await readJson(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw httpError(400, 'invalid_input', 'The body must be a JSON object.');
    const ctx = { actorUserId: identity.userId, actorName: identity.name, via: 'ui' };
    const out = route[2]({ db, body, ctx, url, m: path.match(route[1]) });
    const payload = { data: out.data };
    if (out.operation) payload.resumen_humano = humanize(out.operation, out.data);
    return send(res, out.status ?? 200, payload);
  }

  return async function handler(req, res) {
    const started = performance.now();
    res.on('finish', () => {
      const path = (req.url || '').split('?')[0];
      if (!path.endsWith('/health')) log({ ts: new Date().toISOString(), method: req.method, path, status: res.statusCode, ms: Math.round(performance.now() - started) });
    });
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof DomainError) {
        return send(res, err.code, err.toJSON(), err.allow ? { allow: err.allow } : {});
      }
      console.error(JSON.stringify({ ts: new Date().toISOString(), msg: 'unhandled error', error: String(err?.stack || err) }));
      if (!res.headersSent) send(res, 500, { error: 'Internal error.', code: 500, reason: 'internal_error' });
    }
  };
}

export function start(env = process.env) {
  for (const name of ['YUVOMI_INTERNAL_URL', 'PUBLIC_ORIGIN']) {
    if (!env[name]) {
      console.error(`${name} is required`);
      process.exit(1);
    }
  }
  const port = Number(env.PORT || 3100);
  const db = openDb(env.DB_PATH || '/data/batteries.db');
  const auth = createAuth({ yuvomiUrl: env.YUVOMI_INTERNAL_URL, publicOrigin: env.PUBLIC_ORIGIN });
  const server = http.createServer(createApp({ db, auth, log: (l) => console.log(JSON.stringify(l)) }));
  server.listen(port, () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `batteries sidecar ${VERSION} listening on ${port}`, prefix: PREFIX }));
  });
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `${signal}: closing` }));
    const force = setTimeout(() => { closeDb(db); process.exit(0); }, 10_000);
    force.unref();
    server.close(() => {
      closeDb(db); // checkpoint the WAL so a file copy (backup) is complete
      process.exit(0);
    });
    server.closeIdleConnections?.();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  return { server, db };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start();
