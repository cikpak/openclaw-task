import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { image, makePdf } from './acceptance/media-fixtures.mjs';
import { client, settings } from './acceptance/credentials.mjs';
const connection = await client();
try {
  const chat = await connection.create('Media acceptance', settings);
  const bytes = Buffer.from(
    'TEXT_FIXTURE_TOKEN\nPrivate input text for the native read tool.',
  );
  const before = await (
    await fetch(`${connection.origin}/__acceptance/status`)
  ).json();
  const upload = await connection.upload(bytes, 'text/plain', 'source.txt');
  const after = await (
    await fetch(`${connection.origin}/__acceptance/status`)
  ).json();
  assert.equal(
    after.bootId,
    before.bootId,
    'Staging must not request a new engine boot',
  );
  assert.ok(upload.uploadId);
  const markdown = await connection.upload(
    Buffer.from('# MARKDOWN_FIXTURE_TOKEN'),
    'text/markdown',
    'source.md',
  );
  const pdf = await connection.upload(
    makePdf('PDF_FIXTURE_TOKEN'),
    'application/pdf',
    'source.pdf',
  );
  const png = await connection.upload(image, 'image/png', 'source.png');
  const sent = [upload, markdown, pdf, png];
  await connection.command({
    type: 'conversation.message.send',
    chatId: chat.id,
    text: 'Read every attached document and image and report their contents.',
    uploadIds: sent.map((file) => file.uploadId),
  });
  const consumed = await connection.completed(chat.id, 'TEXT_FIXTURE_TOKEN');
  for (const marker of [
    'MARKDOWN_FIXTURE_TOKEN',
    'PDF_FIXTURE_TOKEN',
    'IMAGE_FIXTURE_RECEIVED',
  ])
    assert.ok(
      consumed.messages.some(
        (message) =>
          message.role === 'assistant' && message.text.includes(marker),
      ),
      `Native handoff must expose ${marker} to model`,
    );
  const boundaryUploads = [];
  const boundaryHashes = new Map();
  for (const marker of [
    'PDF_FIRST_BOUNDARY_TOKEN',
    'PDF_SECOND_BOUNDARY_TOKEN',
  ]) {
    const padded = makePdf(marker, Math.floor(4.75 * 1024 * 1024));
    boundaryHashes.set(
      `large-${boundaryUploads.length + 1}.pdf`,
      createHash('sha256').update(padded).digest('hex'),
    );
    boundaryUploads.push(
      await connection.upload(
        padded,
        'application/pdf',
        `large-${boundaryUploads.length + 1}.pdf`,
      ),
    );
  }
  await connection.command({
    type: 'conversation.message.send',
    chatId: chat.id,
    text: 'Read both newly attached PDF documents.',
    uploadIds: boundaryUploads.map((file) => file.uploadId),
  });
  const boundaryResult = await connection.completed(
    chat.id,
    'PDF_FIRST_BOUNDARY_TOKEN',
  );
  assert.ok(
    boundaryResult.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.text.includes('PDF_SECOND_BOUNDARY_TOKEN'),
    ),
    'Both PDFs must be consumed beyond the SDK base64-frame boundary',
  );
  const publicPdfData = JSON.stringify({
    frames: connection.frames,
    snapshot: boundaryResult,
  });
  for (const marker of [
    '.pdf-read-',
    '.messenger-inputs',
    'extracted-text.txt',
  ])
    assert.ok(
      !publicPdfData.includes(marker),
      'PDF companions stay private in live/history data',
    );
  assert.ok(!/page-\d+\.png/u.test(publicPdfData));
  for (const upload of boundaryUploads)
    assert.ok(
      boundaryResult.messages.some((message) =>
        message.attachments?.some(
          (file) =>
            file.uploadId === upload.uploadId && file.name === upload.name,
        ),
      ),
      'Public history retains original PDF attachment metadata',
    );
  for (const upload of boundaryUploads) {
    const permission = await connection.command({
      type: 'files.resolve',
      chatId: chat.id,
      fileId: upload.uploadId,
    });
    const response = await connection.request(permission.download.url);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, upload.size);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      boundaryHashes.get(upload.name),
      'PDF extraction preserves original downloadable bytes',
    );
  }
  connection.socket.close();
  await connection.connect();
  const shared = await connection.command({
    type: 'files.list',
    chatId: chat.id,
    category: 'shared',
  });
  assert.deepEqual(
    new Set(shared.files.map((file) => file.id)),
    new Set([...sent, ...boundaryUploads].map((file) => file.uploadId)),
    'All sent metadata survives reconnect',
  );
  for (const marker of [
    '.pdf-read-',
    '.messenger-inputs',
    'extracted-text.txt',
  ])
    assert.ok(
      !JSON.stringify(shared).includes(marker),
      'Private PDF companions are absent from public catalogue',
    );

  await connection.command({
    type: 'conversation.message.send',
    chatId: chat.id,
    text: 'TOOL_WRITE_FIXTURE',
  });
  await connection.completed(chat.id);
  assert.equal(
    (await connection.snapshot(chat.id)).tools?.length ?? 0,
    0,
    'Private native file activity is suppressed',
  );
  await connection.command({
    type: 'conversation.message.send',
    chatId: chat.id,
    text: 'TOOL_WRITE_DOC_FIXTURE',
  });
  await connection.completed(chat.id, 'Generated document ready.');
  const generated = await connection.command({
    type: 'files.list',
    chatId: chat.id,
    category: 'generated',
  });
  const file = generated.files.find(
    (entry) => entry.name === 'artifact-fixture.txt',
  );
  assert.ok(
    file,
    'Successful native write must classify the documents deliverable',
  );
  assert.ok(!JSON.stringify(generated).includes('/recovery/'));
  const summary = (await connection.snapshot(chat.id)).tools?.find(
    (tool) => tool.name === 'write' && tool.status === 'completed',
  );
  assert.ok(summary, 'Eligible successful write emits a concise summary');
  assert.equal(summary.parameters, '');
  assert.ok(!JSON.stringify(summary).includes('/recovery/'));
  connection.socket.close();
  await connection.connect();
  assert.ok(
    (await connection.snapshot(chat.id)).tools?.some(
      (tool) => tool.id === summary.id,
    ),
    'Safe summary survives reconnect',
  );

  const resolved = await connection.command({
    type: 'files.resolve',
    chatId: chat.id,
    fileId: file.id,
  });
  assert.match(resolved.download.url, /^\/downloads\/[a-f0-9]{64}$/u);
  const downloaded = await connection.request(resolved.download.url);
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), 'TOOL_FILE_TOKEN');
  assert.equal(
    (await connection.request(resolved.download.url)).status,
    401,
    'Download ticket is single use',
  );
  const other = await connection.create('Media isolation acceptance', settings);
  await assert.rejects(
    connection.command({
      type: 'files.resolve',
      chatId: other.id,
      fileId: file.id,
    }),
    /NOT_FOUND|FORBIDDEN|FILE/u,
  );
  console.info(
    'PASS WS staging, native attachment consumption, eligible native deliverable, opaque single-use download and cross-chat isolation. Deterministic test provider only.',
  );
} finally {
  await connection.close();
}
