import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime, login, ticket, origin } from './runtime.mjs';

async function connect(app, session) {
  const issued = await ticket(app, session.cookie);
  const response = await app.public(
    `/ws/conversation?ticket=${issued.ticket}`,
    { headers: { origin, cookie: session.cookie, Upgrade: 'websocket' } },
  );
  return { response, issued };
}

test('backend outage fails closed before accepting socket and does not invent access', async () => {
  const app = await runtime({ backendUnavailable: true });
  try {
    const session = await login(app);
    const { response, issued } = await connect(app, session);
    assert.equal(response.status, 401);
    assert.equal(response.webSocket, null);
    const consumed = await app.private('/internal/auth/consume', {
      ticket: issued.ticket,
      sessionToken: session.sessionToken,
      managerId: 'primary',
      origin,
    });
    assert.equal(consumed.status, 200);
  } finally {
    await app.mf.dispose();
  }
});

test('actual DO alarm renews backend grant then closes at local grant deadline', async () => {
  const app = await runtime({ probe: true });
  try {
    const session = await login(app);
    const { response } = await connect(app, session);
    assert.equal(response.status, 101);
    response.webSocket.accept();
    const namespace = await app.mf.getDurableObjectNamespace(
      'MANAGERS',
      'manager',
    );
    const stub = namespace.get(namespace.idFromName('primary'));
    const old = Date.now() + 60_000;
    await app.db
      .prepare('UPDATE manager_grants SET expires_at = ?')
      .bind(old)
      .run();
    await stub.testRenew();
    const row = await app.db
      .prepare('SELECT expires_at FROM manager_grants')
      .first();
    assert.ok(row.expires_at > old);
    const closed = new Promise((resolve) =>
      response.webSocket.addEventListener(
        'close',
        (event) => {
          response.webSocket.close();
          resolve(event);
        },
        { once: true },
      ),
    );
    await stub.testExpire();
    const event = await closed;
    assert.equal(event.code, 4001);
  } finally {
    await app.mf.dispose();
  }
});
