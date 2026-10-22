import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { runtime, login, ticket, origin } from './runtime.mjs';
let app;
before(async () => {
  app = await runtime();
});
after(async () => {
  await app?.mf.dispose();
});

test('real workerd scrypt login stores only hashed session and sets protected cookie', async () => {
  const { cookie, sessionToken, response } = await login(app);
  assert.match(response.headers.get('set-cookie'), /Secure/i);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(response.headers.get('set-cookie'), /SameSite=Lax/i);
  const row = await app.db
    .prepare(
      'SELECT token_hash FROM auth_sessions ORDER BY created_at DESC LIMIT 1',
    )
    .first();
  assert.equal(row.token_hash.length, 64);
  assert.notEqual(row.token_hash, sessionToken);
  const session = await app.public('/api/session', { headers: { cookie } });
  assert.equal((await session.json()).authenticated, true);
});

test('ticket is exact-session, correct-manager and origin bound then atomic single use', async () => {
  const session = await login(app);
  const other = await login(app);
  const issued = await ticket(app, session.cookie);
  assert.equal(issued.address, '/ws/conversation');
  assert.ok(issued.expiresAt <= Date.now() + 60_000);
  const base = {
    ticket: issued.ticket,
    sessionToken: session.sessionToken,
    managerId: 'primary',
    origin,
  };
  for (const change of [
    { sessionToken: other.sessionToken },
    { managerId: 'other' },
    { origin: 'https://evil.test' },
  ]) {
    assert.equal(
      (await app.private('/internal/auth/consume', { ...base, ...change }))
        .status,
      401,
    );
  }
  const attempts = await Promise.all([
    app.private('/internal/auth/consume', base),
    app.private('/internal/auth/consume', base),
  ]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 401]);
  // A discarded/lost successful response cannot make the ticket valid again.
  assert.equal((await app.private('/internal/auth/consume', base)).status, 401);
});

test('grant renewal is capped by original session expiry; logout revokes permissions', async () => {
  const session = await login(app);
  const issued = await ticket(app, session.cookie);
  const response = await app.private('/internal/auth/consume', {
    ticket: issued.ticket,
    sessionToken: session.sessionToken,
    managerId: 'primary',
    origin,
  });
  const { grant } = await response.json();
  assert.ok(grant.expiresAt <= Date.now() + 15 * 60_000);
  const cap = Date.now() + 30_000;
  await app.db
    .prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?')
    .bind(cap, grant.sessionId)
    .run();
  const renewed = await app.private('/internal/auth/renew', {
    grantId: grant.id,
    managerId: 'primary',
  });
  assert.equal((await renewed.json()).grant.expiresAt, cap);
  const logout = await app.public('/api/session', {
    method: 'DELETE',
    headers: { origin, cookie: session.cookie },
  });
  assert.equal(logout.status, 204);
  assert.equal(
    (
      await app.private('/internal/auth/check', {
        grantId: grant.id,
        managerId: 'primary',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await app.public('/api/connection-tickets', {
        method: 'POST',
        headers: { origin, cookie: session.cookie },
      })
    ).status,
    401,
  );
});

test('expired tickets and sessions reject; public facade hides all internal routes', async () => {
  const session = await login(app);
  const issued = await ticket(app, session.cookie);
  await app.db.prepare('UPDATE connection_tickets SET expires_at = 0').run();
  assert.equal(
    (
      await app.private('/internal/auth/consume', {
        ticket: issued.ticket,
        sessionToken: session.sessionToken,
        managerId: 'primary',
        origin,
      })
    ).status,
    401,
  );
  assert.equal(
    (await app.public('/internal/auth/consume', { method: 'POST' })).status,
    404,
  );
  assert.equal((await app.public('/api/unknown')).status, 404);
  const denied = await app.public('/api/session', {
    method: 'DELETE',
    headers: { origin: 'https://evil.test', cookie: session.cookie },
  });
  assert.equal(denied.status, 403);
  await app.db.prepare('UPDATE auth_sessions SET expires_at = 0').run();
  const status = await app.public('/api/session', {
    headers: { cookie: session.cookie },
  });
  assert.equal((await status.json()).authenticated, false);
});
