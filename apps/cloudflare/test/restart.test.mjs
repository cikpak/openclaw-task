import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtime, login, ticket, origin } from './runtime.mjs';

async function socket(app, session) {
  const permission = await ticket(app, session.cookie);
  const response = await app.public(
    `/ws/conversation?ticket=${permission.ticket}`,
    { headers: { origin, cookie: session.cookie, Upgrade: 'websocket' } },
  );
  assert.equal(response.status, 101);
  response.webSocket.accept();
  return response.webSocket;
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

test('D1 session and accepted SQLite queue survive a complete workerd process restart', async () => {
  await mkdir('../../.context', { recursive: true });
  const storageRoot = await mkdtemp(resolve('../../.context/phase2-restart-'));
  let app;
  try {
    app = await runtime({ storageRoot });
    const session = await login(app);
    const first = await socket(app, session);
    const creation = await command(first, {
      type: 'chat.create',
      settings: {
        model: 'configured/provider-model',
        thinkingLevel: 'off',
        fastMode: false,
      },
    });
    assert.equal(creation.ok, true);
    const chatId = creation.data.chat.id;
    const commandId = randomUUID();
    const accepted = await command(first, {
      type: 'conversation.message.send',
      commandId,
      chatId,
      text: 'Survives a process restart',
    });
    assert.equal(accepted.ok, true);
    first.close();
    await app.mf.dispose();
    app = undefined;
    app = await runtime({ storageRoot });
    const continued = await socket(app, session);
    const snapshot = await command(continued, {
      type: 'conversation.snapshot.request',
      chatId,
    });
    assert.equal(snapshot.ok, true);
    assert.equal(
      snapshot.data.snapshot.pending[0].text,
      'Survives a process restart',
    );
    const receipt = await command(continued, {
      type: 'command.receipt.request',
      receiptCommandId: commandId,
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.data.receipt.state, 'accepted');
    continued.close();
  } finally {
    await app?.mf.dispose();
    await rm(storageRoot, { recursive: true, force: true });
  }
});
