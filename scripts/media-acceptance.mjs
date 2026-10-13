import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  seedWorkspaceImage,
  IMAGE_FIXTURE_BYTES,
} from './seed-media-fixture.mjs';

// Runs only against the documented deterministic provider in compose.test.yaml.
assert.match(
  process.env.ACCEPTANCE_PROJECT ?? '',
  /^messenger-acceptance-[a-z0-9-]+$/u,
);
process.loadEnvFile('.context/test.env');
const require = createRequire(
  new URL('../apps/backend/package.json', import.meta.url),
);
const WebSocket = require('ws');
const origin =
  process.env.ACCEPTANCE_ORIGIN ??
  `http://localhost:${process.env.ACCEPTANCE_PORT ?? 18082}`;
const password = await readFile('.context/test-password.txt', 'utf8');
let cookie = '';
async function request(path, options = {}) {
  const json = typeof options.body === 'string';
  return fetch(origin + path, {
    ...options,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
}
async function checked(path, options, expected = 200) {
  const response = await request(path, options);
  if (response.status !== expected) {
    const error = await response.json().catch(() => ({}));
    assert.fail(
      `${path} returned ${response.status}: ${error.code ?? 'unexpected response'}`,
    );
  }
  return response;
}
function makePdf(text) {
  const stream = `BT /F1 18 Tf 36 750 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join(
      '',
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const unauthenticatedShared = await request(
  `/api/chats/${randomUUID()}/shared-files`,
);
assert.equal(
  unauthenticatedShared.status,
  401,
  'Shared-file reads require authentication before chat lookup',
);
const login = await checked('/api/session', {
  method: 'POST',
  body: JSON.stringify({ username: process.env.APP_USERNAME, password }),
});
cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
assert.ok(cookie);
const models = await (await checked('/api/models')).json();
const model = models.models.find((entry) => entry.id === 'mock/test-model');
assert.ok(
  model?.input.includes('text') && model.input.includes('image'),
  'Fixture model must advertise real image capability',
);
const settings = {
  model: model.id,
  thinkingLevel: model.thinkingDefault,
  fastMode: false,
};
const chats = [];
async function create(name) {
  const chat = await (
    await checked(
      '/api/chats',
      {
        method: 'POST',
        body: JSON.stringify({ commandId: randomUUID(), name, settings }),
      },
      201,
    )
  ).json();
  chats.push(chat.id);
  const deadline = Date.now() + 20_000;
  let status = chat.status;
  while (status === 'creating' && Date.now() < deadline) {
    await delay(200);
    status = (await (await checked(`/api/chats/${chat.id}`)).json()).status;
  }
  assert.equal(
    status,
    'idle',
    `New media chat must become idle; actual status ${status}`,
  );
  return chat.id;
}
let socket;
const frames = [];
async function connect() {
  socket = new WebSocket(origin.replace(/^http/, 'ws') + '/ws/conversation', {
    headers: { cookie, origin },
  });
  socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}
async function command(value) {
  const commandId = randomUUID();
  socket.send(JSON.stringify({ ...value, commandId }));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = frames.find(
      (frame) =>
        frame.type === 'command.result' && frame.commandId === commandId,
    );
    if (result) {
      assert.ok(
        result.ok,
        `Command ${value.type} failed: ${result.error?.code ?? ''}`,
      );
      return result.data;
    }
    await delay(100);
  }
  assert.fail(`Timed out waiting for ${value.type}`);
}
async function upload(bytes, mime, name) {
  const body = new FormData();
  body.append('file', new Blob([bytes], { type: mime }), name);
  return (await checked('/api/uploads', { method: 'POST', body }, 201)).json();
}
async function consumed(chatId, marker) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const { snapshot } = await command({
      type: 'conversation.snapshot.request',
      chatId,
    });
    if (
      snapshot.messages.some(
        (message) =>
          message.role === 'assistant' && message.text.includes(marker),
      ) &&
      !snapshot.activeRun &&
      !snapshot.pending.length
    )
      return snapshot;
    await delay(250);
  }
  assert.fail(`Actual provider did not consume ${marker}`);
}
try {
  const chatId = await create('Media acceptance');
  await connect();
  const fixtures = [
    {
      bytes: Buffer.from('TEXT_FIXTURE_TOKEN'),
      mime: 'text/plain',
      name: 'text.txt',
      marker: 'TEXT_FIXTURE_TOKEN',
    },
    {
      bytes: Buffer.from('# Title\n\nMARKDOWN_FIXTURE_TOKEN'),
      mime: 'text/markdown',
      name: 'note.md',
      marker: 'MARKDOWN_FIXTURE_TOKEN',
    },
    {
      bytes: makePdf('PDF_FIXTURE_TOKEN'),
      mime: 'application/pdf',
      name: 'document.pdf',
      marker: 'PDF_FIXTURE_TOKEN',
    },
    {
      bytes: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
      mime: 'image/png',
      name: 'pixel.png',
      marker: 'IMAGE_FIXTURE_RECEIVED',
    },
  ];
  const sentFiles = [];
  for (const fixture of fixtures) {
    const file = await upload(fixture.bytes, fixture.mime, fixture.name);
    await command({
      type: 'conversation.message.send',
      chatId,
      text: 'Describe the attached file.',
      uploadIds: [file.uploadId],
    });
    await consumed(chatId, fixture.marker);
    sentFiles.push(file);
    const shared = await (
      await checked(`/api/chats/${chatId}/shared-files`)
    ).json();
    assert.ok(shared.files.length <= 100, 'Shared-file metadata is bounded');
    for (const sent of sentFiles) {
      const retained = shared.files.find(
        (item) => item.uploadId === sent.uploadId,
      );
      assert.deepEqual(
        retained,
        {
          uploadId: sent.uploadId,
          name: sent.name,
          mimeType: sent.mimeType,
          size: sent.size,
        },
        'Sent attachment metadata remains available after pending consumption',
      );
    }
    console.info(`PASS real Gateway attachment consumption: ${fixture.mime}`);
  }
  await command({
    type: 'conversation.message.send',
    chatId,
    text: 'TOOL_WRITE_FIXTURE',
  });
  await consumed(chatId, 'Real Gateway integration response.');
  const deadline = Date.now() + 60_000;
  while (
    Date.now() < deadline &&
    !frames.some(
      (frame) =>
        frame.type === 'conversation.tool' &&
        frame.chatId === chatId &&
        frame.tool.name === 'write' &&
        frame.tool.status === 'completed',
    )
  )
    await delay(100);
  assert.ok(
    frames.some(
      (frame) =>
        frame.type === 'conversation.tool' &&
        frame.chatId === chatId &&
        frame.tool.name === 'write' &&
        frame.tool.status === 'completed',
    ),
    'Real allowed tool completion event is required',
  );
  socket.close();
  await connect();
  const recovered = await command({
    type: 'conversation.snapshot.request',
    chatId,
  });
  assert.ok(
    recovered.snapshot.tools.some(
      (tool) => tool.name === 'write' && tool.status === 'completed',
    ),
    'Tool activity must survive browser reconnect',
  );
  const afterReconnect = await (
    await checked(`/api/chats/${chatId}/shared-files`)
  ).json();
  assert.deepEqual(
    new Set(afterReconnect.files.map((file) => file.uploadId)),
    new Set(sentFiles.map((file) => file.uploadId)),
    'Shared uploads survive reconnect after pending rows are gone',
  );
  console.info(
    'PASS real Gateway tool activity and browser reconnect snapshot',
  );
  seedWorkspaceImage(chatId);
  await command({
    type: 'conversation.message.send',
    chatId,
    text: 'TOOL_READ_IMAGE_FIXTURE',
  });
  await consumed(chatId, 'Real Gateway integration response.');
  const catalog = await (
    await checked(`/api/chats/${chatId}/artifacts`)
  ).json();
  const image = catalog.artifacts.find(
    (artifact) => artifact.mimeType === 'image/png',
  );
  assert.ok(
    image,
    'Pinned Gateway must expose a native tool-result image artifact',
  );
  const downloaded = await checked(
    `/api/chats/${chatId}/artifacts/${encodeURIComponent(image.id)}`,
  );
  assert.deepEqual(
    Buffer.from(await downloaded.arrayBuffer()),
    IMAGE_FIXTURE_BYTES,
    'Scoped Gateway artifact bytes must match original image',
  );
  const otherId = await create('Artifact isolation acceptance');
  const otherShared = await (
    await checked(`/api/chats/${otherId}/shared-files`)
  ).json();
  assert.deepEqual(
    otherShared.files,
    [],
    'Other chats cannot read sent attachment metadata',
  );
  const otherCatalog = await (
    await checked(`/api/chats/${otherId}/artifacts`)
  ).json();
  assert.ok(
    !otherCatalog.artifacts.some((artifact) => artifact.id === image.id),
  );
  const denied = await request(
    `/api/chats/${otherId}/artifacts/${encodeURIComponent(image.id)}`,
  );
  assert.ok(!denied.ok, 'Artifacts from another chat must be rejected');
  console.info(
    'PASS real Gateway scoped artifact catalog/download and cross-chat isolation',
  );
} finally {
  socket?.close();
  for (const chatId of chats) {
    const response = await request(`/api/chats/${chatId}`);
    if (response.ok)
      await request(`/api/chats/${chatId}`, {
        method: 'DELETE',
        headers: { 'if-match': response.headers.get('etag') ?? '' },
      });
  }
  await request('/api/session', { method: 'DELETE' });
}
console.info(
  'PASS media acceptance uses real OpenClaw with a local deterministic provider. No credential-controlled live-provider check is claimed.',
);
