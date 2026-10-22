import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
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
  const response = await app.public(
    `/ws/conversation?ticket=${permission.ticket}`,
    {
      headers: { origin, cookie: session.cookie, Upgrade: 'websocket' },
    },
  );
  if (response.status === 101) response.webSocket.accept();
  return response;
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
const settings = {
  model: 'configured/provider-model',
  thinkingLevel: 'off',
  fastMode: false,
};

test('ambiguous cookie and duplicated admission ticket fail without consuming valid permission', async () => {
  const session = await login(app);
  const other = await login(app);
  const issued = await ticket(app, session.cookie);
  for (const [query, cookie] of [
    [`ticket=${issued.ticket}&ticket=${issued.ticket}`, session.cookie],
    [`ticket=${issued.ticket}`, `${session.cookie}; ${other.cookie}`],
  ]) {
    const response = await app.public(`/ws/conversation?${query}`, {
      headers: { origin, cookie, Upgrade: 'websocket' },
    });
    assert.equal(response.status, 401);
  }
  const sessionStatus = await app.public('/api/session', {
    headers: { cookie: `${session.cookie}; ${other.cookie}` },
  });
  assert.equal((await sessionStatus.json()).authenticated, false);
  const admitted = await connect(session, issued);
  assert.equal(admitted.status, 101);
  admitted.webSocket.close();
});

test('one socket operates multiple owned chats while rejecting another account references', async () => {
  const first = await login(app);
  const socket = (await connect(first)).webSocket;
  const own = await command(socket, {
    type: 'chat.create',
    name: 'Owned A',
    settings,
  });
  const secondOwn = await command(socket, {
    type: 'chat.create',
    name: 'Owned B',
    settings,
  });
  assert.equal(own.ok, true);
  assert.equal(secondOwn.ok, true);
  for (const chat of [own.data.chat, secondOwn.data.chat]) {
    const read = await command(socket, { type: 'chat.get', chatId: chat.id });
    assert.equal(read.ok, true);
    assert.equal(read.data.chat.id, chat.id);
  }
  const acceptedId = randomUUID();
  assert.equal(
    (
      await command(socket, {
        type: 'conversation.message.send',
        commandId: acceptedId,
        chatId: own.data.chat.id,
        text: 'Private accepted message',
      })
    ).ok,
    true,
  );
  const other = await login(app);
  await app.db
    .prepare('UPDATE auth_sessions SET account_id = ? WHERE token_hash = ?')
    .bind(
      'other',
      createHash('sha256').update(other.sessionToken).digest('hex'),
    )
    .run();
  const attacker = (await connect(other)).webSocket;
  const otherChat = await command(attacker, {
    type: 'chat.create',
    name: 'Other account',
    settings,
  });
  assert.equal(otherChat.ok, true);
  for (const request of [
    { type: 'chat.get', chatId: own.data.chat.id },
    { type: 'chat.settings.get', chatId: own.data.chat.id },
    { type: 'conversation.snapshot.request', chatId: own.data.chat.id },
    { type: 'files.list', chatId: own.data.chat.id, category: 'all' },
    {
      type: 'files.resolve',
      chatId: otherChat.data.chat.id,
      fileId: 'unowned-file',
    },
    { type: 'upload.remove', uploadId: randomUUID() },
    {
      type: 'conversation.message.send',
      chatId: otherChat.data.chat.id,
      text: 'bad upload',
      uploadIds: [randomUUID()],
    },
    { type: 'command.receipt.request', receiptCommandId: acceptedId },
    {
      type: 'conversation.message.send',
      commandId: acceptedId,
      chatId: otherChat.data.chat.id,
      text: 'cross-account command collision',
    },
  ]) {
    const denied = await command(attacker, request);
    assert.equal(denied.ok, false, request.type);
    assert.equal(denied.error.code, 'NOT_FOUND', request.type);
  }
  const list = await command(attacker, { type: 'chat.list' });
  assert.deepEqual(
    list.data.chats.map((chat) => chat.id),
    [otherChat.data.chat.id],
  );
  const snapshots = await command(attacker, {
    type: 'conversation.snapshot.request',
  });
  assert.deepEqual(
    snapshots.data.snapshots.map((snapshot) => snapshot.chat.id),
    [otherChat.data.chat.id],
  );
  socket.close();
  attacker.close();
});

test('expired grants cannot renew or issue download permissions even with live sessions', async () => {
  const session = await login(app);
  const issued = await ticket(app, session.cookie);
  const { grant } = await (
    await app.private('/internal/auth/consume', {
      ticket: issued.ticket,
      sessionToken: session.sessionToken,
      managerId: 'primary',
      origin,
    })
  ).json();
  await app.db
    .prepare('UPDATE manager_grants SET expires_at = 0 WHERE id = ?')
    .bind(grant.id)
    .run();
  for (const path of [
    '/internal/auth/check',
    '/internal/auth/renew',
    '/internal/downloads/issue',
  ]) {
    const response = await app.private(path, {
      grantId: grant.id,
      managerId: 'primary',
      fileId: 'eligible-file',
    });
    assert.equal(response.status, 401, path);
  }
  const status = await app.public('/api/session', {
    headers: { cookie: session.cookie },
  });
  assert.equal((await status.json()).authenticated, true);
});
