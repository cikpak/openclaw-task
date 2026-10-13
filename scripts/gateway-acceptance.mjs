import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(
  new URL('../apps/backend/package.json', import.meta.url),
);
const WebSocket = require('ws');
process.loadEnvFile('.context/test.env');
const base =
  process.env.ACCEPTANCE_ORIGIN ??
  `http://localhost:${process.env.ACCEPTANCE_PORT ?? 18080}`;
const password = await readFile('.context/test-password.txt', 'utf8');
let cookie = '';
async function request(path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      origin: base,
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
  });
}
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  try {
    if ((await request('/ready')).ok) break;
  } catch {
    /* Wait for startup. */
  }
  await delay(2000);
}
assert.equal(
  (await request('/ready')).status,
  200,
  'Gateway must authenticate and reconcile',
);
const login = await request('/api/session', {
  method: 'POST',
  body: JSON.stringify({ username: process.env.APP_USERNAME, password }),
});
assert.equal(login.status, 200, 'Login must succeed');
cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
assert.ok(cookie, 'Encrypted session cookie is required');
const models = await (await request('/api/models')).json();
const model = models.models.find((entry) => entry.id === 'mock/test-model');
assert.ok(
  model?.available,
  'Real Gateway must project configured provider capability',
);
const settings = {
  model: model.id,
  thinkingLevel: model.thinkingDefault,
  fastMode: false,
};
const created = await request('/api/chats', {
  method: 'POST',
  body: JSON.stringify({
    commandId: randomUUID(),
    name: 'Gateway acceptance',
    settings,
  }),
});
assert.equal(
  created.status,
  201,
  'Chat must create its real agent and canonical session',
);
const chat = await created.json();
const chatId = chat.id ?? chat.chat?.id;
assert.ok(chatId, 'Chat identity must be present');
const createDeadline = Date.now() + 45_000;
let chatStatus = chat.status;
while (chatStatus === 'creating' && Date.now() < createDeadline) {
  await delay(250);
  const current = await request(`/api/chats/${chatId}`);
  assert.equal(current.status, 200);
  chatStatus = (await current.json()).status;
}
assert.equal(
  chatStatus,
  'idle',
  'Created agent must finish canonical session initialization',
);
const effective = await (await request(`/api/chats/${chatId}/settings`)).json();
assert.equal(
  effective.effective.model,
  'mock/test-model',
  'Session model must read back',
);

const events = [];
const socket = new WebSocket(base.replace('http', 'ws') + '/ws/conversation', {
  headers: { cookie, origin: base },
});
socket.on('message', (raw) => {
  events.push(JSON.parse(raw.toString()));
});
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
const commandId = randomUUID();
socket.send(
  JSON.stringify({
    type: 'conversation.message.send',
    commandId,
    chatId,
    text: 'Verify real Gateway streaming.',
  }),
);
const runDeadline = Date.now() + 90_000;
while (Date.now() < runDeadline) {
  const snapshot = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === 'conversation.snapshot' &&
        event.snapshot.chat.id === chatId,
    );
  if (
    snapshot?.snapshot.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.text.includes('Real Gateway integration response.'),
    )
  )
    break;
  const failed = events.find(
    (event) =>
      event.type === 'command.result' &&
      event.commandId === commandId &&
      !event.ok,
  );
  assert.ok(!failed, `Send failed: ${failed?.error?.code ?? ''}`);
  await delay(200);
}
assert.ok(
  events.some(
    (event) =>
      event.type === 'command.result' &&
      event.commandId === commandId &&
      event.ok,
  ),
  'Send acknowledgement required',
);
assert.ok(
  events.some(
    (event) =>
      event.type === 'conversation.run.text' && event.chatId === chatId,
  ),
  'Streaming text required',
);
assert.ok(
  events.some(
    (event) =>
      event.type === 'conversation.snapshot' &&
      event.snapshot.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.text.includes('Real Gateway integration response.'),
      ),
  ),
  'Canonical transcript required',
);
socket.close();

const logout = await request('/api/session', { method: 'DELETE' });
assert.equal(logout.status, 204);
assert.equal(
  (await request('/api/chats')).status,
  401,
  'Revoked cookie must be rejected',
);
console.info(
  'PASS real Gateway: encrypted device authentication, models, agent/session creation, settings read-back, streaming, canonical history, and logout revocation. Provider is deterministic/local; no live-provider check claimed.',
);
