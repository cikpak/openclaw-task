import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime, login, ticket, origin } from './runtime.mjs';

for (const [description, frame, expected] of [
  ['malformed JSON', '{', 1007],
  ['oversized text', 'x'.repeat(128 * 1024 + 1), 1009],
  ['binary frame', new Uint8Array([1, 2, 3]), 1009],
]) {
  test(`manager rejects ${description} with a controlled workerd-compatible close`, async () => {
    const app = await runtime();
    try {
      const session = await login(app);
      const permission = await ticket(app, session.cookie);
      const response = await app.public(
        `/ws/conversation?ticket=${permission.ticket}`,
        {
          headers: { origin, cookie: session.cookie, Upgrade: 'websocket' },
        },
      );
      assert.equal(response.status, 101);
      const socket = response.webSocket;
      socket.accept();
      const event = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.close();
          reject(Error('Frame rejection did not close socket'));
        }, 1500);
        socket.addEventListener(
          'close',
          (closed) => {
            clearTimeout(timeout);
            socket.close();
            resolve(closed);
          },
          { once: true },
        );
        socket.send(frame);
      });
      assert.equal(event.code, expected);
      assert.equal(JSON.stringify(app.logs).includes('TypeError'), false);
      const rows = await app.db
        .prepare('SELECT count(*) AS count FROM auth_sessions')
        .first();
      assert.equal(
        rows.count,
        1,
        'bad frame does not revoke the browser session',
      );
    } finally {
      await app.mf.dispose();
    }
  });
}
