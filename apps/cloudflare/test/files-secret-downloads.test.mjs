import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filesRuntime } from './files-runtime.mjs';
import { login, ticket, origin } from './runtime.mjs';
test('an already-issued permission cannot publish a credential-containing input after private recovery commit while asleep', async () => {
  const app = await filesRuntime();
  try {
    const session = await login(app),
      connection = await ticket(app, session.cookie);
    const { grant } = await (
      await app.private('/internal/auth/consume', {
        ticket: connection.ticket,
        sessionToken: session.sessionToken,
        managerId: 'primary',
        origin,
      })
    ).json();
    const file = await app.probe('seed', { grant, size: 32 });
    const permission = await app.probe('resolve', { ...file, grant });
    assert.match(permission.download.url, /^\/downloads\/[a-f0-9]{64}$/);
    const audit = await app.probe('private-input', file);
    assert.equal(audit.eligible, false);
    assert.equal(audit.committedSource, null);
    assert.equal(
      audit.originalPresent,
      true,
      'original staging bytes exist but cannot serve as stale fallback',
    );
    assert.equal(
      audit.privatePresent,
      true,
      'meaningful credential-containing bytes remain preserved privately',
    );
    assert.equal(audit.privateDigest, audit.expectedDigest);
    assert.equal(audit.engineAbsent, true, 'no engine is available to wake');
    const response = await app.public(permission.download.url, {
      headers: { cookie: session.cookie },
    });
    assert.ok(
      response.status >= 500,
      `permission must fail closed after audit, got ${response.status}`,
    );
    assert.equal(response.headers.has('location'), false);
    const body = await response.text();
    assert.equal(body.includes('preserved-known-account-secret'), false);
    assert.equal(body.includes('/recovery/'), false);
    assert.equal(body.includes('Private account configuration'), false);
    assert.equal((await app.probe('stats')).readers, 0);
  } finally {
    await app.mf.dispose();
  }
});
