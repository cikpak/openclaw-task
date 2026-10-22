import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
/** Only a refused loopback TCP connection proves the owned listener is absent. */
export function ownedPortClosed(origin) {
  const url = new URL(origin);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) > 0 && Number(url.port) <= 65535);
  return new Promise((resolve) => {
    const socket = createConnection({
      host: '127.0.0.1',
      port: Number(url.port),
    });
    const finish = (closed) => {
      socket.destroy();
      resolve(closed);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', (error) => finish(error.code === 'ECONNREFUSED'));
    socket.setTimeout(500, () => finish(false));
  });
}
