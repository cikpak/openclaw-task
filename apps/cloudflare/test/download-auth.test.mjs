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

test('download permissions expire exactly60s after issue, enforce exact session and atomically consume', async () => {
  const session = await login(app);
  const other = await login(app);
  const connection = await ticket(app, session.cookie);
  const admission = await app.private('/internal/auth/consume', {
    ticket: connection.ticket,
    sessionToken: session.sessionToken,
    managerId: 'primary',
    origin,
  });
  const { grant } = await admission.json();
  const before = Date.now();
  const issue = await app.private('/internal/downloads/issue', {
    grantId: grant.id,
    managerId: 'primary',
    fileId: 'eligible-file-id',
  });
  assert.equal(issue.status, 200);
  const permission = await issue.json();
  assert.ok(
    permission.expiresAt >= before + 60_000 &&
      permission.expiresAt <= Date.now() + 60_000,
  );
  const base = {
    ticket: permission.ticket,
    sessionToken: session.sessionToken,
    managerId: 'primary',
  };
  assert.equal(
    (
      await app.private('/internal/downloads/consume', {
        ...base,
        sessionToken: other.sessionToken,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await app.private('/internal/downloads/consume', {
        ...base,
        managerId: 'wrong',
      })
    ).status,
    401,
  );
  const consumed = await app.private('/internal/downloads/consume', base);
  assert.equal(consumed.status, 200);
  const result = await consumed.json();
  assert.equal(result.fileId, 'eligible-file-id');
  assert.equal(result.grant.sessionId, grant.sessionId);
  assert.equal(
    (await app.private('/internal/downloads/consume', base)).status,
    401,
  );
  const second = await app.private('/internal/downloads/issue', {
    grantId: grant.id,
    managerId: 'primary',
    fileId: 'eligible-file-id',
  });
  const expired = await second.json();
  await app.db.prepare('UPDATE download_tickets SET expires_at = 0').run();
  assert.equal(
    (
      await app.private('/internal/downloads/consume', {
        ...base,
        ticket: expired.ticket,
      })
    ).status,
    401,
  );
});

test('download ticket survives original socket grant expiry but rejects session logout', async () => {
  const session = await login(app);
  const connection = await ticket(app, session.cookie);
  const { grant } = await (
    await app.private('/internal/auth/consume', {
      ticket: connection.ticket,
      sessionToken: session.sessionToken,
      managerId: 'primary',
      origin,
    })
  ).json();
  const args = {
    grantId: grant.id,
    managerId: 'primary',
    fileId: 'eligible-file-id',
  };
  const first = await (
    await app.private('/internal/downloads/issue', args)
  ).json();
  const second = await (
    await app.private('/internal/downloads/issue', args)
  ).json();
  await app.db
    .prepare('UPDATE manager_grants SET expires_at = 0 WHERE id = ?')
    .bind(grant.id)
    .run();
  const consumed = await app.private('/internal/downloads/consume', {
    ticket: first.ticket,
    sessionToken: session.sessionToken,
    managerId: 'primary',
  });
  assert.equal(consumed.status, 200);
  await app.public('/api/logout', {
    method: 'POST',
    headers: { origin, cookie: session.cookie },
  });
  assert.equal(
    (
      await app.private('/internal/downloads/consume', {
        ticket: second.ticket,
        sessionToken: session.sessionToken,
        managerId: 'primary',
      })
    ).status,
    401,
  );
});
