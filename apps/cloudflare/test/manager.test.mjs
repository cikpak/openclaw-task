import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runtime, login, ticket, origin } from './runtime.mjs';
let app;
before(async () => {
  app = await runtime();
});
after(async () => {
  await app?.mf.dispose();
});
async function connect(session, issued) {
  const permission = issued ?? (await ticket(app, session.cookie));
  return app.public(`/ws/conversation?ticket=${permission.ticket}`, {
    headers: { origin, cookie: session.cookie, Upgrade: 'websocket' },
  });
}
function command(socket, data) {
  const value = { commandId: randomUUID(), ...data };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', receive);
      reject(Error('No command response'));
    }, 3000);
    function receive(event) {
      const result = JSON.parse(event.data);
      if (result.commandId !== value.commandId) return;
      clearTimeout(timer);
      socket.removeEventListener('message', receive);
      resolve(result);
    }
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify(value));
  });
}

test('manager admits before upgrade, prevents replay/mismatch and never logs sentinel ticket', async () => {
  const session = await login(app);
  const issued = await ticket(app, session.cookie);
  const other = await login(app);
  const mismatch = await connect(other, issued);
  assert.equal(mismatch.status, 401);
  const admitted = await connect(session, issued);
  assert.equal(admitted.status, 101);
  admitted.webSocket.accept();
  assert.equal((await connect(session, issued)).status, 401);
  const sentinel = 'SENTINEL_PRIVATE_TICKET_NEVER_LOG';
  const denied = await app.public(`/ws/conversation?ticket=${sentinel}`, {
    headers: { origin, cookie: session.cookie, Upgrade: 'websocket' },
  });
  assert.equal(denied.status, 401);
  assert.ok(
    app.logs.some((entry) => entry.includes('correlationId')),
    'application outcomes were captured',
  );
  assert.equal(JSON.stringify(app.logs).includes(sentinel), false);
  assert.equal(JSON.stringify(app.logs).includes(issued.ticket), false);
  assert.equal(JSON.stringify(app.logs).includes(session.sessionToken), false);
  admitted.webSocket.close();
});

test('manager enforces each referenced resource and persists accepted work through logout', async () => {
  const session = await login(app);
  const response = await connect(session);
  const socket = response.webSocket;
  socket.accept();
  const create = await command(socket, {
    type: 'chat.create',
    name: 'Durable queue',
    settings: {
      model: 'configured/provider-model',
      thinkingLevel: 'off',
      fastMode: false,
    },
  });
  assert.equal(create.ok, true);
  const chatId = create.data.chat.id;
  const foreign = await command(socket, {
    type: 'chat.get',
    chatId: randomUUID(),
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.code, 'NOT_FOUND');
  const foreignFile = await command(socket, {
    type: 'files.resolve',
    chatId,
    fileId: 'not-owned',
  });
  assert.equal(foreignFile.ok, false);
  assert.equal(foreignFile.error.code, 'NOT_FOUND');
  const sendId = randomUUID();
  const sent = await command(socket, {
    type: 'conversation.message.send',
    commandId: sendId,
    chatId,
    text: 'Accepted before logout',
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.data.receipt.state, 'accepted');
  const replay = await command(socket, {
    type: 'conversation.message.send',
    commandId: sendId,
    chatId,
    text: 'Accepted before logout',
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.data.messageId, sent.data.messageId);
  const invalidReuse = await command(socket, {
    type: 'conversation.message.send',
    commandId: sendId,
    chatId,
    text: 'Altered command',
  });
  assert.equal(invalidReuse.ok, false);
  assert.equal(invalidReuse.error.code, 'COMMAND_ID_REUSED');
  const closed = new Promise((resolve) =>
    socket.addEventListener('close', resolve, { once: true }),
  );
  await app.public('/api/logout', {
    method: 'POST',
    headers: { origin, cookie: session.cookie },
  });
  await closed;
  const nextSession = await login(app);
  const next = await connect(nextSession);
  next.webSocket.accept();
  const snapshot = await command(next.webSocket, {
    type: 'conversation.snapshot.request',
    chatId,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(
    snapshot.data.snapshot.pending.filter(
      (item) => item.id === sent.data.messageId,
    ).length,
    1,
  );
  const receipt = await command(next.webSocket, {
    type: 'command.receipt.request',
    receiptCommandId: sendId,
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.data.receipt.state, 'accepted');
  next.webSocket.close();
});

test('session expiry prevents socket command access even without a revocation notification', async () => {
  const session = await login(app);
  const response = await connect(session);
  response.webSocket.accept();
  await app.db.prepare('UPDATE auth_sessions SET expires_at = 0').run();
  const closed = new Promise((resolve) =>
    response.webSocket.addEventListener('close', resolve, { once: true }),
  );
  const result = await command(response.webSocket, { type: 'chat.list' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTHENTICATION_REQUIRED');
  await closed;
});

test('unsupported uploads return correlated 415 and the same socket remains usable', async () => {
  const session = await login(app);
  const response = await connect(session);
  const socket = response.webSocket;
  socket.accept();
  try {
    const commandId = randomUUID();
    const result = await command(socket, {
      type: 'upload.begin',
      commandId,
      name: 'document.html',
      mimeType: 'text/html',
      size: 10,
    });
    assert.equal(result.commandId, commandId);
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 415);
    assert.equal(result.error.code, 'UNSUPPORTED_ATTACHMENT');
    const invalidId = randomUUID();
    const malformed = await command(socket, {
      type: 'upload.begin',
      commandId: invalidId,
      name: 'document.txt',
      mimeType: 'text/plain\nprivate',
      size: 10,
    });
    assert.equal(malformed.commandId, invalidId);
    assert.equal(malformed.error.status, 400);
    assert.equal(JSON.stringify(malformed).includes('private'), false);
    const next = await command(socket, {
      type: 'upload.begin',
      name: 'document.txt',
      mimeType: 'text/plain',
      size: 10,
    });
    assert.equal(next.ok, true);
    assert.equal(typeof next.data.uploadId, 'string');
    assert.equal(next.data.nextOffset, 0);
  } finally {
    socket.close();
  }
});
