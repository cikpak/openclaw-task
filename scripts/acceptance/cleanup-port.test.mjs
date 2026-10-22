import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { ownedPortClosed } from './cleanup-port.mjs';
test('accepting nonresponsive TCP listener is open, never mistaken for HTTP timeout/closure', async () => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await ownedPortClosed(origin), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  assert.equal(
    await ownedPortClosed(origin),
    true,
    'Only actual connection refusal proves closure',
  );
});
test('cleanup port verifier refuses non-owned destinations', () => {
  assert.throws(() => ownedPortClosed('https://example.com'));
  assert.throws(() => ownedPortClosed('http://192.0.2.1:12345'));
});
