// A stand-in for Yuvomi's GET /api/v1/auth/me and a running sidecar on an ephemeral port.
import http from 'node:http';
import { createAuth } from '../app/auth.mjs';
import { createApp } from '../app/server.mjs';
import { memoryDb } from './helpers.mjs';

export const ORIGIN = 'https://familia.example.test';
export const PREFIX = '/api/extensions/batteries';

const member = (id, name, modules, extra = {}) => ({
  user: { id, role: 'member', access_scope: 'family', display_name: name, ...extra },
  permissions: { admin: false, modules, widgets: {}, capabilities: {} },
});

// credential (session id or token) → /auth/me body; special values simulate failures.
export const PEOPLE = {
  admin: { user: { id: 1, role: 'admin', access_scope: 'family', display_name: 'Marco' }, permissions: { admin: true, modules: {} } },
  writer: member(2, 'Yesenia', { 'ext:batteries': 'write' }),
  reader: member(3, 'Ángel', { 'ext:batteries': 'read' }),
  nobody: member(4, 'Visita', {}),
  'perm-admin': member(5, 'Abuela', {}, {}),
  guest: { user: { id: 6, role: 'member', access_scope: 'split_guest', display_name: 'Invitado' }, permissions: { admin: false, modules: { 'ext:batteries': 'write' } } },
};
PEOPLE['perm-admin'].permissions.admin = true;

export function fakeYuvomi() {
  const calls = [];
  async function fetch(url, { headers = {} } = {}) {
    const auth = headers.authorization || '';
    const cookie = headers.cookie || '';
    const sid = /(?:^|;\s*)yuvomi\.sid=([^;]+)/.exec(cookie)?.[1];
    const cred = auth.startsWith('Bearer ') ? auth.slice(7) : sid;
    calls.push({ url, headers, cred });
    if (cred === 'boom') throw new Error('connect ECONNREFUSED');
    if (cred === 'down') return new Response('{"error":"x"}', { status: 503 });
    const me = PEOPLE[cred];
    if (!me) return new Response('{"error":"Not authenticated.","code":401}', { status: 401 });
    return new Response(JSON.stringify(me), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return { fetch, calls };
}

export async function startApp({ db = memoryDb(), clock } = {}) {
  const yuvomi = fakeYuvomi();
  const auth = createAuth({ yuvomiUrl: 'http://yuvomi.test:3000', publicOrigin: ORIGIN, fetch: yuvomi.fetch, now: clock });
  const server = http.createServer(createApp({ db, auth }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, yuvomi, base, close: () => new Promise((r) => server.close(r)) };
}

// http.request, so Origin and Cookie are sent exactly as given.
export function call(base, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { accept: 'application/json', ...headers };
    if (data !== undefined) { h['content-type'] ??= 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const req = http.request(base + path, { method, headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

export const bearer = (who) => ({ authorization: `Bearer ${who}` });
// A browser request from the module page: session cookie, csrf double-submit, exact Origin.
export const browser = (who, { origin = ORIGIN, csrf = 'tok-1', header = csrf } = {}) => ({
  cookie: `yuvomi.sid=${who}; csrf-token=${csrf}`, origin, 'x-csrf-token': header,
});
