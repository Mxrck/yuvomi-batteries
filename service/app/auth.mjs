// Who is calling, and may they read or write? The only source of truth is Yuvomi's
// GET /api/v1/auth/me, asked with the caller's own credential: the browser's session cookie
// (module page) or `Authorization: Bearer <Yuvomi API token>` (the agent). Never both at once.
// Nothing in a request body is trusted for identity.
//
// Answers are cached per credential (5 s; 2 s for a refusal) so a page full of requests does not
// spend Yuvomi's per-IP rate limit; 5xx and network errors are never cached.
import { createHash } from 'node:crypto';
import { DomainError } from './errors.mjs';

export const MODULE_KEY = 'ext:batteries';
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const RANK = { none: 0, read: 1, write: 2 };

const refuse = (code, reason, message, details) => new DomainError(code, reason, message, details);

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const s = part.trim();
    const i = s.indexOf('=');
    if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

function originOf(value, name) {
  let url = null;
  try { url = new URL(value); } catch { /* reported below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must be an absolute http(s) URL such as https://home.example, got ${JSON.stringify(value)}`);
  }
  return url.origin;
}

const hash = (s) => createHash('sha256').update(s).digest('base64url');

// Household members only: a split-expense guest or a wall display has a session too, but Yuvomi
// keeps those on their own surfaces and this service must not be a way around that. A missing
// permission key (module not installed yet) fails closed for members.
function accessFrom(me) {
  if (me?.user?.role === 'admin' || me?.permissions?.admin === true) return 'write';
  const level = me?.permissions?.modules?.[MODULE_KEY];
  return level === 'write' || level === 'read' ? level : 'none';
}

export function createAuth({
  yuvomiUrl, publicOrigin, fetch = globalThis.fetch, cacheMs = 5000, deniedMs = 2000, now = Date.now,
  sessionCookie = 'yuvomi.sid', csrfCookie = 'csrf-token', timeoutMs = 5000,
}) {
  const base = originOf(yuvomiUrl, 'YUVOMI_INTERNAL_URL');
  const expectedOrigin = originOf(publicOrigin, 'PUBLIC_ORIGIN');
  const cache = new Map(); // credential hash → { until, value | null }

  function credentialOf(req) {
    const authz = req.headers.authorization;
    const cookieHeader = req.headers.cookie;
    const session = parseCookies(cookieHeader)[sessionCookie];
    if (authz !== undefined) {
      const m = /^Bearer\s+(\S+)\s*$/i.exec(authz);
      if (!m) throw refuse(401, 'not_authenticated', 'Only Bearer tokens are accepted.');
      if (session !== undefined) throw refuse(400, 'credentials_conflict', 'Send a session cookie or a Bearer token, not both.');
      return { type: 'bearer', key: `b:${hash(m[1])}`, headers: { authorization: `Bearer ${m[1]}` } };
    }
    if (session) return { type: 'cookie', key: `c:${hash(session)}`, headers: { cookie: cookieHeader } };
    throw refuse(401, 'not_authenticated', 'Not authenticated.');
  }

  async function resolve(req) {
    const cred = credentialOf(req);
    const hit = cache.get(cred.key);
    if (hit && hit.until > now()) {
      if (hit.value === null) throw refuse(401, 'not_authenticated', 'Not authenticated.');
      return hit.value;
    }

    // The caller's address travels along so Yuvomi's per-IP limit is spent by that caller, not by
    // this container for the whole household.
    const forwardedFor = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
    const headers = { accept: 'application/json', ...cred.headers };
    if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
    let res;
    try {
      res = await fetch(`${base}/api/v1/auth/me`, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw refuse(502, 'yuvomi_unavailable', 'Yuvomi did not answer.');
    }
    if (res.status === 401 || res.status === 403) {
      cache.set(cred.key, { until: now() + deniedMs, value: null });
      throw refuse(401, 'not_authenticated', 'Not authenticated.');
    }
    if (!res.ok) throw refuse(502, 'yuvomi_unavailable', `Yuvomi answered ${res.status}.`);
    let me;
    try { me = await res.json(); } catch { throw refuse(502, 'yuvomi_unavailable', 'Yuvomi answered something that is not JSON.'); }
    const userId = Number(me?.user?.id);
    if (!Number.isInteger(userId) || userId < 1) throw refuse(502, 'yuvomi_unavailable', 'Yuvomi answered without a user.');

    const value = {
      userId,
      name: String(me.user.display_name || me.user.username || `#${userId}`),
      role: String(me.user.role || 'member'),
      scope: me.user.access_scope ?? null,
      access: accessFrom(me),
      credential: cred.type,
    };
    if (cache.size >= 1000) cache.clear();
    cache.set(cred.key, { until: now() + cacheMs, value });
    return value;
  }

  // need: 'read' | 'write', or an HTTP method (GET/HEAD read, anything else write).
  function authorize(identity, need) {
    const want = need === 'read' || need === 'write' ? need : (need === 'GET' || need === 'HEAD' ? 'read' : 'write');
    if (identity.scope !== 'family') throw refuse(403, 'family_scope_required', 'Only household members can use this module.');
    if (RANK[identity.access] < RANK[want]) {
      throw refuse(403, 'permission_required', `This needs ${want} access to the batteries module.`, { need: want });
    }
  }

  // Double submit + exact Origin, only for cookie credentials (a Bearer token is never sent by the
  // browser on its own, so there is no ambient credential to protect).
  function assertCsrf(req, identity) {
    if (identity.credential !== 'cookie' || !MUTATING.has(req.method)) return;
    const header = req.headers['x-csrf-token'];
    const cookie = parseCookies(req.headers.cookie)[csrfCookie];
    if (req.headers.origin !== expectedOrigin || !header || header !== cookie) {
      throw refuse(403, 'csrf_invalid', 'Cross-site request refused.');
    }
  }

  return { resolve, authorize, assertCsrf };
}
