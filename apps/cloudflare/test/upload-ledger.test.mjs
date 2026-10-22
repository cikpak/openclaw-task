import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { runtime, login, ticket, origin } from './runtime.mjs';
let app, probe;
before(async () => {
  app = await runtime({ probe: true, r2: true });
  const namespace = await app.mf.getDurableObjectNamespace(
    'MANAGERS',
    'manager',
  );
  probe = namespace.get(namespace.idFromName('primary'));
});
after(async () => {
  await app?.mf.dispose();
});
async function connect() {
  const session = await login(app),
    permission = await ticket(app, session.cookie);
  const response = await app.public(
    `/ws/conversation?ticket=${permission.ticket}`,
    { headers: { origin, cookie: session.cookie, Upgrade: 'websocket' } },
  );
  assert.equal(response.status, 101);
  response.webSocket.accept();
  return response.webSocket;
}
function send(socket, command) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', receive);
      reject(new Error('No command reply'));
    }, 5000);
    function receive(event) {
      const result = JSON.parse(event.data);
      if (result.commandId !== command.commandId) return;
      clearTimeout(timer);
      socket.removeEventListener('message', receive);
      resolve(result);
    }
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify(command));
  });
}
const fingerprint = (command) => {
  const { commandId, type, ...fields } = command;
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ commandId, type, ...fields }))
    .digest('hex')}`;
};
test('actual manager WebSocket keeps compact immutable upload command fingerprints after cancellation', async () => {
  const socket = await connect();
  try {
    const bytes = Buffer.alloc(48 * 1024, 97),
      base64 = bytes.toString('base64');
    const begin = {
      type: 'upload.begin',
      commandId: randomUUID(),
      name: 'private-input.txt',
      mimeType: 'text/plain',
      size: bytes.length,
    };
    const begun = await send(socket, begin);
    assert.equal(begun.ok, true);
    const chunk = {
      type: 'upload.chunk',
      commandId: randomUUID(),
      uploadId: begun.data.uploadId,
      offset: 0,
      base64,
    };
    assert.equal((await send(socket, chunk)).ok, true);
    assert.equal(
      (await send(socket, chunk)).ok,
      true,
      'exact chunk replay remains idempotent',
    );
    const changed = await send(socket, {
      ...chunk,
      base64: Buffer.alloc(bytes.length, 98).toString('base64'),
    });
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, 'COMMAND_ID_REUSED');
    const remove = {
      type: 'upload.remove',
      commandId: randomUUID(),
      uploadId: begun.data.uploadId,
    };
    assert.equal((await send(socket, remove)).ok, true);
    const rows = await probe.testCommandLedger();
    for (const command of [begin, chunk, remove])
      assert.equal(
        rows.find((row) => row.id === command.commandId).json,
        fingerprint(command),
      );
    assert.equal(JSON.stringify(rows).includes(base64), false);
    assert.ok(
      rows.every((row) => row.json.length === 71),
      'each durable command identity contains only SHA-256',
    );
  } finally {
    socket.close();
  }
});
test('actual manager migrates a legacy JSON identity on exact replay and preserves resource ownership', async () => {
  const socket = await connect();
  try {
    const base64 = Buffer.from('legacy-private-input').toString('base64');
    const begin = {
      type: 'upload.begin',
      commandId: randomUUID(),
      name: 'legacy.txt',
      mimeType: 'text/plain',
      size: Buffer.from(base64, 'base64').length,
    };
    const begun = await send(socket, begin);
    assert.equal(begun.ok, true);
    const chunk = {
      type: 'upload.chunk',
      commandId: randomUUID(),
      uploadId: begun.data.uploadId,
      offset: 0,
      base64,
    };
    assert.equal((await send(socket, chunk)).ok, true);
    await probe.testLegacyCommand(chunk);
    assert.equal((await send(socket, chunk)).ok, true);
    assert.equal(
      (await probe.testCommandLedger()).find(
        (row) => row.id === chunk.commandId,
      ).json,
      fingerprint(chunk),
    );
    const changed = await send(socket, { ...chunk, offset: 1 });
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, 'COMMAND_ID_REUSED');
    const owner = await probe.testCommandOwner(chunk.commandId);
    await probe.testCommandOwner(chunk.commandId, 'different-account');
    const rejected = await send(socket, chunk);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'NOT_FOUND');
    assert.equal(
      await probe.testCommandOwner(chunk.commandId),
      'different-account',
      'replay cannot take ownership',
    );
    await probe.testCommandOwner(chunk.commandId, owner);
    assert.equal((await send(socket, chunk)).ok, true);
    await send(socket, {
      type: 'upload.remove',
      commandId: randomUUID(),
      uploadId: begun.data.uploadId,
    });
  } finally {
    socket.close();
  }
});
