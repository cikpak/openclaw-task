import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

// This command can incur provider charges. It is never part of automated acceptance.
assert.equal(
  process.env.LIVE_PROVIDER_SMOKE,
  '1',
  'Explicit LIVE_PROVIDER_SMOKE=1 opt-in is required',
);
assert.ok(
  process.env.LIVE_PROVIDER_PASSWORD_FILE,
  'Supply a private password file for the separately configured stack',
);
const origin = process.env.LIVE_PROVIDER_ORIGIN ?? 'http://localhost:8080';
const password = await readFile(
  process.env.LIVE_PROVIDER_PASSWORD_FILE,
  'utf8',
);
const username = process.env.LIVE_PROVIDER_USERNAME ?? 'admin';
const name = `Disposable smoke ${randomUUID()}`;
const require = createRequire(
  new URL('../apps/backend/package.json', import.meta.url),
);
const WebSocket = require('ws');
let cookie = '';
let chatId;
let socket;
async function request(path, options = {}) {
  return fetch(origin + path, {
    ...options,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
}
async function checked(path, options = {}, status = 200) {
  const response = await request(path, options);
  assert.equal(
    response.status,
    status,
    `Smoke endpoint ${path} did not return ${status}`,
  );
  return response;
}
try {
  await checked('/ready');
  const login = await checked('/api/session', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie);
  const { models } = await (await checked('/api/models')).json();
  const model = models.find(
    (item) => item.available && item.id === process.env.LIVE_PROVIDER_MODEL,
  );
  assert.ok(
    model && !model.id.startsWith('mock/'),
    'Choose an available external LIVE_PROVIDER_MODEL explicitly',
  );
  const chat = await (
    await checked(
      '/api/chats',
      {
        method: 'POST',
        body: JSON.stringify({
          commandId: randomUUID(),
          name,
          settings: {
            model: model.id,
            thinkingLevel: model.thinkingDefault,
            fastMode: false,
          },
        }),
      },
      201,
    )
  ).json();
  chatId = chat.id;
  assert.ok(chatId);
  const createDeadline = Date.now() + 45_000;
  let status = chat.status;
  while (status === 'creating' && Date.now() < createDeadline) {
    await delay(250);
    status = (await (await checked(`/api/chats/${chatId}`)).json()).status;
  }
  assert.equal(
    status,
    'idle',
    'The disposable smoke agent must finish initialization',
  );
  const frames = [];
  socket = new WebSocket(origin.replace(/^http/u, 'ws') + '/ws/conversation', {
    headers: { cookie, origin },
  });
  socket.on('message', (raw) => {
    frames.push(JSON.parse(raw.toString()));
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
      text: 'Reply with a short greeting. Do not call tools.',
    }),
  );
  const deadline = Date.now() + 120_000;
  let completed = false;
  while (Date.now() < deadline) {
    const failure = frames.find(
      (frame) =>
        frame.type === 'command.result' &&
        frame.commandId === commandId &&
        !frame.ok,
    );
    assert.ok(!failure, 'Live-provider submission was rejected');
    const snapshot = frames.findLast(
      (frame) =>
        frame.type === 'conversation.snapshot' &&
        frame.snapshot.chat.id === chatId,
    )?.snapshot;
    if (
      snapshot &&
      !snapshot.activeRun &&
      !snapshot.pending.length &&
      snapshot.messages.some(
        (message) => message.role === 'assistant' && message.text.trim(),
      )
    ) {
      completed = true;
      break;
    }
    await delay(250);
  }
  assert.ok(
    completed,
    'Expected a completed nonempty canonical response, with no exact wording constraint',
  );
  console.info(
    'PASS opt-in live-provider smoke: authenticated chat, accepted input, nonempty completed canonical response. No response content or credentials logged.',
  );
} finally {
  socket?.close();
  if (cookie && !chatId) {
    const response = await request('/api/chats');
    if (response.ok) {
      const { chats } = await response.json();
      chatId = chats.find((chat) => chat.name === name)?.id;
    }
  }
  if (chatId) {
    const chat = await request(`/api/chats/${chatId}`);
    if (chat.ok)
      await request(`/api/chats/${chatId}`, {
        method: 'DELETE',
        headers: { 'if-match': chat.headers.get('etag') ?? '' },
      });
  }
  if (cookie) await request('/api/session', { method: 'DELETE' });
}
