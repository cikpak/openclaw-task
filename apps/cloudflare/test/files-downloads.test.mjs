import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { filesRuntime } from './files-runtime.mjs';
import { login, ticket, origin } from './runtime.mjs';
let app, session, other, grant, file;
before(async () => {
  app = await filesRuntime();
  session = await login(app);
  other = await login(app);
  const connection = await ticket(app, session.cookie);
  const response = await app.private('/internal/auth/consume', {
    ticket: connection.ticket,
    sessionToken: session.sessionToken,
    managerId: 'primary',
    origin,
  });
  ({ grant } = await response.json());
  file = await app.probe('seed', { grant, size: 5 * 1024 * 1024 });
});
after(async () => {
  await app?.mf.dispose();
});
async function resolve() {
  return app.probe('resolve', { ...file, grant });
}
function download(url, cookie = session.cookie, headers = {}) {
  return app.public(url, { headers: { cookie, ...headers } });
}
test('actual ManagerFiles asleep input download stays private, exact-session and single-use through public facade', async () => {
  const resolved = await resolve();
  assert.match(resolved.download.url, /^\/downloads\/[a-f0-9]{64}$/);
  assert.ok(resolved.download.expiresAt > Date.now() + 59_000);
  assert.ok(resolved.download.expiresAt <= Date.now() + 60_000);
  const wrong = await download(resolved.download.url, other.cookie);
  assert.equal(wrong.status, 401);
  assert.equal(
    (
      await download(resolved.download.url, session.cookie, {
        origin: 'https://evil.example',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await download(resolved.download.url, session.cookie, {
        'sec-fetch-site': 'cross-site',
      })
    ).status,
    403,
  );
  const response = await download(resolved.download.url);
  assert.equal(
    response.status,
    200,
    response.status === 200 ? undefined : await response.clone().text(),
  );
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(response.headers.has('location'), false);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, 5 * 1024 * 1024);
  assert.ok(bytes.every((byte) => byte === 97));
  assert.equal((await download(resolved.download.url)).status, 401);
  const stats = await app.probe('stats');
  assert.equal(stats.live, false);
  assert.equal(stats.readers, 0);
});
test('actual public download rejects permission expiry exactly before admission', async () => {
  const resolved = await resolve();
  await app.db.prepare('UPDATE download_tickets SET expires_at=0').run();
  assert.equal((await download(resolved.download.url)).status, 401);
});
test('admitted R2 stream finishes after permission/session expiry and logout without another authorization or wake', async () => {
  const resolved = await resolve(),
    unused = await resolve(),
    response = await download(resolved.download.url);
  assert.equal(
    response.status,
    200,
    response.status === 200 ? undefined : await response.clone().text(),
  );
  const reader = response.body.getReader(),
    first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(
    first.value.length < 5 * 1024 * 1024,
    'logout occurs before all bytes are received',
  );
  const hash = createHash('sha256');
  hash.update(first.value);
  let length = first.value.length;
  await app.db.prepare('UPDATE download_tickets SET expires_at=0').run();
  await app.public('/api/logout', {
    method: 'POST',
    headers: { origin, cookie: session.cookie },
  });
  await app.db.prepare('UPDATE auth_sessions SET expires_at=0').run();
  assert.equal((await download(unused.download.url)).status, 401);
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    hash.update(part.value);
    length += part.value.length;
  }
  assert.equal(length, 5 * 1024 * 1024);
  assert.equal(
    hash.digest('hex'),
    createHash('sha256').update(Buffer.alloc(length, 97)).digest('hex'),
  );
  assert.equal((await download(resolved.download.url)).status, 401);
  assert.equal((await app.probe('stats')).readers, 0);
});
