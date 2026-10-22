import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { AcceptanceClient } from './client.mjs';
const require = createRequire(
  new URL('../../apps/backend/package.json', import.meta.url),
);
const { WebSocketServer } = require('ws');

test('a command after connection closure fails as transport loss without writing', async () => {
  const client = new AcceptanceClient('http://example.test', 'test', 'test');
  let writes = 0;
  client.socket = { readyState: 3, send: () => writes++ };
  await assert.rejects(client.command({ type: 'chat.list' }, 1), {
    code: 'CONNECTION_CLOSED',
    status: 503,
  });
  assert.equal(writes, 0);
  assert.equal(client.replies.size, 0);
});

test('a synchronous send failure retires the pending command', async () => {
  const client = new AcceptanceClient('http://example.test', 'test', 'test');
  client.socket = {
    readyState: 1,
    send: () => {
      throw new Error('transport failure');
    },
  };
  await assert.rejects(client.command({ type: 'chat.list' }, 1), {
    code: 'CONNECTION_CLOSED',
    status: 503,
  });
  assert.equal(client.replies.size, 0);
});

test('an asynchronous write failure retires the pending command', async () => {
  const client = new AcceptanceClient('http://example.test', 'test', 'test');
  client.socket = {
    readyState: 1,
    send: (_text, callback) => {
      queueMicrotask(() => callback(new Error('transport failure')));
    },
  };
  await assert.rejects(client.command({ type: 'chat.list' }, 1), {
    code: 'CONNECTION_CLOSED',
    status: 503,
  });
  assert.equal(client.replies.size, 0);
});

test('a successful write still waits for the correlated manager response', async () => {
  const client = new AcceptanceClient('http://example.test', 'test', 'test');
  client.socket = {
    readyState: 1,
    send: (text, callback) => {
      callback();
      const { commandId } = JSON.parse(text);
      queueMicrotask(() =>
        client.frame({
          type: 'command.result',
          commandId,
          ok: true,
          data: { chats: [] },
        }),
      );
    },
  };
  assert.deepEqual(await client.command({ type: 'chat.list' }), { chats: [] });
  assert.equal(client.replies.size, 0);
});

test('the real socket close between commands cannot become a read timeout', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const client = new AcceptanceClient(
    `http://127.0.0.1:${port}`,
    'test',
    'test',
  );
  client.request = () =>
    Promise.resolve(
      Response.json({ address: '/ws/conversation', ticket: 'test-ticket' }),
    );
  server.on('connection', (socket) => socket.close(1000, 'Test finished'));
  await client.connect();
  if (client.socket.readyState !== 3) await once(client.socket, 'close');
  await assert.rejects(client.command({ type: 'files.list' }, 1), {
    code: 'CONNECTION_CLOSED',
    status: 503,
  });
  assert.equal(client.replies.size, 0);
});
