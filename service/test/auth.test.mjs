// auth.mjs on its own: credentials, permissions, cache, CSRF. Steps 20–23 of the plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../app/auth.mjs';
import { fakeYuvomi, ORIGIN } from './http-helpers.mjs';

function setup() {
  let t = 1_000_000;
  const yuvomi = fakeYuvomi();
  const auth = createAuth({ yuvomiUrl: 'http://yuvomi.test:3000', publicOrigin: ORIGIN, fetch: yuvomi.fetch, now: () => t });
  return { auth, yuvomi, tick: (ms) => { t += ms; } };
}
const req = (headers = {}, method = 'GET', remote = '10.0.0.9') => ({ method, headers, socket: { remoteAddress: remote } });
const reason = async (p) => { try { await p; } catch (e) { return [e.code, e.reason]; } return 'resolved'; };

test('20 · no credential is 401; a foreign access_scope is 403', async () => {
  const { auth } = setup();
  assert.deepEqual(await reason(auth.resolve(req())), [401, 'not_authenticated']);
  assert.deepEqual(await reason(auth.resolve(req({ cookie: 'csrf-token=x; other=1' }))), [401, 'not_authenticated']);
  const guest = await auth.resolve(req({ authorization: 'Bearer guest' }));
  assert.deepEqual(await reason(Promise.resolve().then(() => auth.authorize(guest, 'GET'))), [403, 'family_scope_required']);
});

test('22 · read can GET but not POST; none nothing; admin role or permissions.admin ⇒ write', async () => {
  const { auth } = setup();
  const access = async (who) => (await auth.resolve(req({ authorization: `Bearer ${who}` }))).access;
  assert.equal(await access('reader'), 'read');
  assert.equal(await access('writer'), 'write');
  assert.equal(await access('nobody'), 'none');
  assert.equal(await access('admin'), 'write');
  assert.equal(await access('perm-admin'), 'write');
  const reader = await auth.resolve(req({ authorization: 'Bearer reader' }));
  assert.doesNotThrow(() => auth.authorize(reader, 'GET'));
  assert.throws(() => auth.authorize(reader, 'POST'), (e) => e.code === 403 && e.reason === 'permission_required' && e.details.need === 'write');
  const nobody = await auth.resolve(req({ authorization: 'Bearer nobody' }));
  assert.throws(() => auth.authorize(nobody, 'GET'), (e) => e.reason === 'permission_required' && e.details.need === 'read');
});

test('cookie and Bearer are forwarded as they came, with X-Forwarded-For; both at once is refused', async () => {
  const { auth, yuvomi } = setup();
  await auth.resolve(req({ cookie: 'yuvomi.sid=writer; csrf-token=a', 'x-forwarded-for': '203.0.113.7' }));
  await auth.resolve(req({ authorization: 'Bearer reader' }, 'GET', '192.168.50.10'));
  assert.equal(yuvomi.calls[0].url, 'http://yuvomi.test:3000/api/v1/auth/me');
  assert.equal(yuvomi.calls[0].headers.cookie, 'yuvomi.sid=writer; csrf-token=a');
  assert.equal(yuvomi.calls[0].headers.authorization, undefined);
  assert.equal(yuvomi.calls[0].headers['x-forwarded-for'], '203.0.113.7');
  assert.equal(yuvomi.calls[1].headers.authorization, 'Bearer reader');
  assert.equal(yuvomi.calls[1].headers.cookie, undefined); // a Bearer request sends no cookie upstream
  assert.equal(yuvomi.calls[1].headers['x-forwarded-for'], '192.168.50.10');
  assert.deepEqual(await reason(auth.resolve(req({ authorization: 'Bearer admin', cookie: 'yuvomi.sid=writer' }))), [400, 'credentials_conflict']);
  assert.deepEqual(await reason(auth.resolve(req({ authorization: 'Basic abc' }))), [401, 'not_authenticated']);
  // A Bearer request may carry unrelated cookies (Cloudflare and the like) without conflict.
  assert.equal((await auth.resolve(req({ authorization: 'Bearer admin', cookie: '__cf_bm=zz' }))).access, 'write');
});

test('cache: 5 s for a valid credential, 2 s for a 401, never for a 5xx or a network error', async () => {
  const { auth, yuvomi, tick } = setup();
  const hits = () => yuvomi.calls.length;
  await auth.resolve(req({ authorization: 'Bearer admin' }));
  await auth.resolve(req({ authorization: 'Bearer admin' }));
  assert.equal(hits(), 1);
  tick(5001);
  await auth.resolve(req({ authorization: 'Bearer admin' }));
  assert.equal(hits(), 2);

  await reason(auth.resolve(req({ authorization: 'Bearer stale' })));
  await reason(auth.resolve(req({ authorization: 'Bearer stale' })));
  assert.equal(hits(), 3);
  tick(2001);
  await reason(auth.resolve(req({ authorization: 'Bearer stale' })));
  assert.equal(hits(), 4);

  assert.deepEqual(await reason(auth.resolve(req({ authorization: 'Bearer down' }))), [502, 'yuvomi_unavailable']);
  assert.deepEqual(await reason(auth.resolve(req({ authorization: 'Bearer down' }))), [502, 'yuvomi_unavailable']);
  assert.equal(hits(), 6);
  assert.deepEqual(await reason(auth.resolve(req({ authorization: 'Bearer boom' }))), [502, 'yuvomi_unavailable']);
});

test('23 · CSRF: cookie writes need the exact Origin and the token pair; Bearer writes do not', async () => {
  const { auth } = setup();
  const cookieId = await auth.resolve(req({ cookie: 'yuvomi.sid=writer; csrf-token=t1' }));
  const ok = { cookie: 'yuvomi.sid=writer; csrf-token=t1', origin: ORIGIN, 'x-csrf-token': 't1' };
  assert.doesNotThrow(() => auth.assertCsrf(req(ok, 'POST'), cookieId));
  for (const bad of [
    { ...ok, origin: 'https://evil.test' },
    { ...ok, origin: undefined },
    { ...ok, 'x-csrf-token': 't2' },
    { ...ok, 'x-csrf-token': undefined },
    { ...ok, cookie: 'yuvomi.sid=writer' },
  ]) {
    assert.throws(() => auth.assertCsrf(req(bad, 'POST'), cookieId), (e) => e.code === 403 && e.reason === 'csrf_invalid', JSON.stringify(bad));
  }
  assert.doesNotThrow(() => auth.assertCsrf(req({ ...ok, origin: 'https://evil.test' }, 'GET'), cookieId));
  const bearerId = await auth.resolve(req({ authorization: 'Bearer writer' }));
  assert.doesNotThrow(() => auth.assertCsrf(req({ authorization: 'Bearer writer', origin: 'https://evil.test' }, 'POST'), bearerId));
});

test('createAuth refuses a missing or relative URL at start-up', () => {
  assert.throws(() => createAuth({ yuvomiUrl: '', publicOrigin: ORIGIN }), /YUVOMI_INTERNAL_URL/);
  assert.throws(() => createAuth({ yuvomiUrl: 'http://y:1', publicOrigin: 'familia.example' }), /PUBLIC_ORIGIN/);
});
