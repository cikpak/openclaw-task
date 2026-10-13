import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { retryThrottledLogin } from './login-cooldown.mjs';

process.loadEnvFile('.context/test.env');
const project = process.env.ACCEPTANCE_PROJECT;
assert.match(
  project ?? '',
  /^messenger-acceptance-[a-z0-9-]+$/u,
  'Use the isolated acceptance runner',
);
const origin =
  process.env.ACCEPTANCE_ORIGIN ??
  `http://localhost:${process.env.ACCEPTANCE_PORT ?? 18080}`;
const compose = [
  'compose',
  '--env-file',
  '.context/test.env',
  '-p',
  project,
  '-f',
  'compose.yaml',
  '-f',
  'compose.test.yaml',
];
const require = createRequire(
  new URL('../apps/backend/package.json', import.meta.url),
);
const WebSocket = require('ws');
let cookie = '';
let socket;
const replies = new Map();
const snapshots = new Map();
let maxSnapshotBytes = 0;
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
  const response =
    path === '/api/session' && options.method === 'POST'
      ? await retryThrottledLogin(() => request(path, options))
      : await request(path, options);
  const problem =
    response.status === status
      ? null
      : await response
          .clone()
          .json()
          .catch(() => null);
  assert.equal(
    response.status,
    status,
    `Capacity endpoint ${path} must return ${status}${problem?.code ? ` (${problem.code})` : ''}`,
  );
  return response;
}
async function catalog() {
  return (await (await checked('/api/chats')).json()).chats;
}
async function until(predicate, description, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(500);
  }
  assert.fail(description);
}
async function cleanup() {
  for (const chat of await catalog()) {
    const response = await request(`/api/chats/${chat.id}`, {
      method: 'DELETE',
      headers: { 'if-match': `"${chat.version}"` },
    });
    assert.ok(response.status === 202 || response.status === 204);
  }
  await until(
    async () => (await catalog()).length === 0,
    'Synthetic conversations must finish deleting before capacity is reused',
  );
}
function providerStats() {
  return JSON.parse(
    execFileSync(
      'docker',
      [
        ...compose,
        'exec',
        '-T',
        'openclaw',
        'node',
        '-e',
        "fetch('http://127.0.0.1:18889/acceptance/stats').then(r=>r.json()).then(s=>console.log(JSON.stringify(s)))",
      ],
      { encoding: 'utf8', timeout: 15_000 },
    ),
  );
}
function sampleResources() {
  return {
    sampledAt: new Date().toISOString(),
    containers: execFileSync(
      'docker',
      [
        'stats',
        '--no-stream',
        '--format',
        '{{json .}}',
        `${project}-backend-1`,
        `${project}-openclaw-1`,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  };
}
async function command(value) {
  const commandId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      replies.delete(commandId);
      reject(new Error(`Timed out: ${value.type}`));
    }, 60_000);
    replies.set(commandId, (frame) => {
      clearTimeout(timer);
      if (frame.ok) resolve(frame.data);
      else
        reject(
          new Error(
            `Rejected ${value.type}: ${frame.error?.code ?? 'UNKNOWN'}`,
          ),
        );
    });
    socket.send(JSON.stringify({ ...value, commandId }));
  });
}
try {
  const password = await readFile('.context/test-password.txt', 'utf8');
  const login = await checked('/api/session', {
    method: 'POST',
    body: JSON.stringify({ username: process.env.APP_USERNAME, password }),
  });
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie);
  await cleanup();
  // Release workers retained by the preceding suite; state and device pairing persist.
  execFileSync('docker', [...compose, 'restart', 'openclaw'], {
    stdio: 'pipe',
    timeout: 60_000,
  });
  await until(
    async () => (await request('/ready')).ok,
    'Gateway must recover after the isolated idle boundary',
  );
  const { models } = await (await checked('/api/models')).json();
  const model = models.find(
    (entry) => entry.id === 'mock/test-model' && entry.available,
  );
  assert.ok(model);
  const settings = {
    model: model.id,
    thinkingLevel: model.thinkingDefault,
    fastMode: false,
  };
  const baseline = sampleResources();
  const chats = await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const response = await checked(
        '/api/chats',
        {
          method: 'POST',
          body: JSON.stringify({
            commandId: randomUUID(),
            name: `Capacity space ${index}`,
            settings,
          }),
        },
        201,
      );
      return response.json();
    }),
  );
  assert.equal(new Set(chats.map((chat) => chat.id)).size, 10);
  assert.equal((await catalog()).length, 10);
  const extra = await Promise.all(
    Array.from({ length: 4 }, async () =>
      request('/api/chats', {
        method: 'POST',
        body: JSON.stringify({
          commandId: randomUUID(),
          name: 'Rejected eleventh space',
          settings,
        }),
      }),
    ),
  );
  for (const response of extra) {
    assert.equal(response.status, 409);
    const problem = await response.json();
    assert.equal(problem.status, 409);
    assert.equal(problem.code, 'CHAT_LIMIT');
  }
  await until(
    async () => (await catalog()).every((chat) => chat.status === 'idle'),
    'All ten real agents must finish canonical session initialization',
  );
  socket = new WebSocket(origin.replace(/^http/u, 'ws') + '/ws/conversation', {
    headers: { cookie, origin },
  });
  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'command.result') {
      replies.get(frame.commandId)?.(frame);
      replies.delete(frame.commandId);
    }
    if (frame.type === 'conversation.snapshot') {
      maxSnapshotBytes = Math.max(
        maxSnapshotBytes,
        Buffer.byteLength(JSON.stringify(frame)),
      );
      snapshots.set(frame.snapshot.chat.id, frame.snapshot);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  await Promise.all(
    chats.map((chat, index) =>
      command({
        type: 'conversation.message.send',
        chatId: chat.id,
        text: `CAPACITY_RESPONSE_FIXTURE CAPACITY_CHAT_${index}`,
      }),
    ),
  );
  await until(
    async () => providerStats().capacity.active === 10,
    'Ten actual agent requests must overlap at the local provider',
    45_000,
  );
  const concurrent = sampleResources();
  assert.equal(providerStats().capacity.peak, 10);
  assert.equal(
    providerStats().capacity.calls,
    10,
    'One logical provider request per unique accepted input',
  );
  await until(async () => {
    const results = await Promise.all(
      chats.map((chat) =>
        command({ type: 'conversation.snapshot.request', chatId: chat.id }),
      ),
    );
    for (const { snapshot } of results) {
      snapshots.set(snapshot.chat.id, snapshot);
      maxSnapshotBytes = Math.max(
        maxSnapshotBytes,
        Buffer.byteLength(JSON.stringify(snapshot)),
      );
    }
    return results.every(
      ({ snapshot }) =>
        !snapshot.activeRun &&
        snapshot.pending.length === 0 &&
        snapshot.messages.some((message) => message.role === 'assistant'),
    );
  }, 'All ten independent runs must complete without unresolved delivery');
  for (const [index, chat] of chats.entries()) {
    const snapshot = snapshots.get(chat.id);
    assert.ok(snapshot);
    assert.ok(
      snapshot.tools.length <= 100 && snapshot.messages.length <= 50,
      'Recent snapshots must obey history/tool resource windows',
    );
    const user = snapshot.messages.filter((message) => message.role === 'user');
    const assistant = snapshot.messages.filter(
      (message) => message.role === 'assistant',
    );
    assert.equal(user.length, 1);
    assert.equal(assistant.length, 1);
    assert.ok(user[0].text.includes(`CAPACITY_CHAT_${index}`));
    assert.ok(assistant[0].text.includes(`CAPACITY_CHAT_${index}`));
    for (let other = 0; other < 10; other++)
      if (other !== index)
        assert.ok(
          !snapshot.messages.some((message) =>
            message.text.includes(`CAPACITY_CHAT_${other}`),
          ),
          'No cross-chat content leakage',
        );
  }
  assert.ok(
    maxSnapshotBytes < 256 * 1024,
    'Small bounded snapshots must stay below 256 KiB under ten concurrent runs',
  );
  await writeFile(
    '.context/resource-evidence.json',
    JSON.stringify(
      {
        project,
        provider: 'deterministic-local',
        concurrentAgents: 10,
        rejectedConcurrentCreates: 4,
        providerStats: providerStats(),
        maxSnapshotBytes,
        baseline,
        concurrent,
        completed: sampleResources(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.info(
    `PASS ten real concurrent agent/model requests, four concurrent eleventh attempts rejected, unique transcript isolation; max snapshot ${maxSnapshotBytes} bytes. Container CPU/memory samples saved to .context/resource-evidence.json; not an external-model benchmark.`,
  );
} finally {
  socket?.close();
  if (cookie) {
    await cleanup();
    await request('/api/session', { method: 'DELETE' });
  }
}
