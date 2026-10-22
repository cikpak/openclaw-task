import { encodeBase64 } from './codec.js';
import { expect, it, vi } from 'vitest';
import type { ManagerCommand } from '@messenger/contracts';
import { UploadService } from './service.js';
import { fixture, begin, complete, addChat } from './test-fixture.js';
it('reserves quota atomically before bytes arrive, retries begin idempotently and isolates accounts', async () => {
  const f = fixture();
  const first = await begin(f, new Uint8Array(5 * 1024 * 1024));
  expect(await f.service.handle(first.command, 'owner')).toEqual({
    uploadId: first.id,
    nextOffset: 0,
  });
  await expect(f.service.handle(first.command, 'other')).rejects.toMatchObject({
    code: 'COMMAND_ID_REUSED',
  });
  for (let i = 1; i < 20; i++) await begin(f, new Uint8Array(5 * 1024 * 1024));
  await expect(begin(f, new TextEncoder().encode('a'))).rejects.toMatchObject({
    code: 'UPLOAD_STORAGE_LIMIT',
  });
  expect(f.bucket.put).not.toHaveBeenCalled();
});
it('keeps chunk offsets/digests durable across service recreation and completes only after persisted valid bytes', async () => {
  const f = fixture(),
    upload = await begin(f);
  const chunk = {
    type: 'upload.chunk',
    commandId: crypto.randomUUID(),
    uploadId: upload.id,
    offset: 0,
    base64: encodeBase64(upload.bytes),
  } as const;
  await f.service.handle(chunk, 'owner');
  const recreated = new UploadService(f.context, f.authorization);
  expect(await recreated.handle(chunk, 'owner')).toEqual({
    uploadId: upload.id,
    nextOffset: 5,
  });
  await expect(
    recreated.handle(
      { ...chunk, base64: encodeBase64(new TextEncoder().encode('other')) },
      'owner',
    ),
  ).rejects.toMatchObject({ code: 'UPLOAD_CHUNK_CONFLICT' });
  const result = await recreated.handle(
    {
      type: 'upload.complete',
      commandId: crypto.randomUUID(),
      uploadId: upload.id,
    },
    'owner',
  );
  expect(result?.upload?.name).toBe('hello.txt');
  expect(f.data.get(recreated.lookup(upload.id)!.key)).toEqual(
    new Uint8Array(upload.bytes),
  );
  expect(recreated.lookup(upload.id)).toMatchObject({
    status: 'complete',
    received: 5,
  });
  expect(recreated.lookup(upload.id)?.sha256).toMatch(/^[a-f0-9]{64}$/);
});
it('rejects malformed magic and corrupted staged objects without acknowledging completion', async () => {
  const f = fixture();
  const upload = await begin(f);
  await f.service.handle(
    {
      type: 'upload.chunk',
      commandId: crypto.randomUUID(),
      uploadId: upload.id,
      offset: 0,
      base64: encodeBase64(upload.bytes),
    },
    'owner',
  );
  const [key] = f.data.keys();
  f.data.set(key!, new Uint8Array(5).fill(42));
  await expect(
    f.service.handle(
      {
        type: 'upload.complete',
        commandId: crypto.randomUUID(),
        uploadId: upload.id,
      },
      'owner',
    ),
  ).rejects.toThrow('corrupted');
  expect(f.service.lookup(upload.id)?.status).toBe('staging');
  const png = {
    type: 'upload.begin',
    commandId: crypto.randomUUID(),
    name: 'fake.png',
    mimeType: 'image/png',
    size: 5,
  } as const;
  const id = (await f.service.handle(png, 'owner'))!.uploadId!;
  await f.service.handle(
    {
      type: 'upload.chunk',
      commandId: crypto.randomUUID(),
      uploadId: id,
      offset: 0,
      base64: encodeBase64(upload.bytes),
    },
    'owner',
  );
  await expect(
    f.service.handle(
      { type: 'upload.complete', commandId: crypto.randomUUID(), uploadId: id },
      'owner',
    ),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
it('bounds queued chunks with backpressure and preserves reservation on failed storage', async () => {
  const f = fixture(),
    upload = await begin(f);
  let release!: () => void;
  f.bucket.put.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    throw new Error('storage failed');
  });
  const chunk = {
    type: 'upload.chunk',
    commandId: crypto.randomUUID(),
    uploadId: upload.id,
    offset: 0,
    base64: encodeBase64(upload.bytes),
  } as const;
  const first = f.service.handle(chunk, 'owner');
  const second = f.service.handle(chunk, 'owner');
  await expect(f.service.handle(chunk, 'owner')).rejects.toMatchObject({
    code: 'UPLOAD_BUSY',
  });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  release();
  await expect(first).rejects.toThrow('storage failed');
  await second;
  expect(f.service.lookup(upload.id)?.received).toBe(5);
});
it('binds inside acceptance transaction, rejects cross-chat reuse and keeps accepted expired uploads', async () => {
  const f = fixture(),
    upload = await complete(f),
    chat = addChat(f);
  const command = {
    type: 'conversation.message.send',
    commandId: crypto.randomUUID(),
    chatId: chat.id,
    text: 'use attachment',
    uploadIds: [upload.id],
  } satisfies ManagerCommand;
  await f.service.prepare(command, 'owner');
  expect(() =>
    f.store.db.transaction(() => {
      f.service.commitReferences(command, chat.id, 'owner');
      throw new Error('accept failed');
    })(),
  ).toThrow('accept failed');
  expect(f.service.lookup(upload.id)?.chatId).toBeNull();
  f.store.db.transaction(() =>
    f.service.commitReferences(command, chat.id, 'owner'),
  )();
  f.store.db
    .prepare('UPDATE staged_uploads SET expires_at=0 WHERE id=?')
    .run(upload.id);
  await f.service.cleanup();
  expect(f.service.lookup(upload.id)?.status).toBe('complete');
  const another = addChat(f);
  await expect(
    f.service.prepare({ ...command, chatId: another.id }, 'owner'),
  ).rejects.toMatchObject({ code: 'UPLOAD_IN_USE' });
  await expect(
    f.service.handle(
      {
        type: 'upload.remove',
        commandId: crypto.randomUUID(),
        uploadId: upload.id,
      },
      'owner',
    ),
  ).rejects.toMatchObject({ code: 'UPLOAD_IN_USE' });
  f.store.removeChat(chat.id);
  await f.service.cleanup();
  expect(f.service.lookup(upload.id)).toBeNull();
});
it('expires only unused uploads and honors active reader guards on deleted chats', async () => {
  const f = fixture(),
    unused = await complete(f);
  f.store.db.prepare('UPDATE staged_uploads SET expires_at=0').run();
  await f.service.cleanup();
  expect(f.service.lookup(unused.id)).toBeNull();
  expect(f.data.size).toBe(0);
  const upload = await complete(f),
    chat = addChat(f);
  f.service.commitReferences(
    {
      type: 'conversation.message.send',
      commandId: crypto.randomUUID(),
      chatId: chat.id,
      text: '',
      uploadIds: [upload.id],
    },
    chat.id,
    'owner',
  );
  f.store.removeChat(chat.id);
  let reading = true;
  const guarded = new UploadService(f.context, f.authorization, () => !reading);
  await guarded.cleanup();
  expect(guarded.lookup(upload.id)).not.toBeNull();
  reading = false;
  await guarded.cleanup();
  expect(guarded.lookup(upload.id)).toBeNull();
});
it('revalidates an accepted initial upload against the existing create identity on retries', async () => {
  const f = fixture(),
    upload = await complete(f),
    chat = addChat(f);
  const command = {
    type: 'chat.create',
    commandId: crypto.randomUUID(),
    settings: chat.settings,
    initialMessage: { text: 'attached', uploadIds: [upload.id] },
  } satisfies ManagerCommand;
  f.store.saveCreationCommand(command.commandId, chat.id, command);
  f.service.commitReferences(command, chat.id, 'owner');
  expect((await f.service.prepare(command, 'owner'))[0]?.uploadId).toBe(
    upload.id,
  );
});
it('enforces the independent two hundred upload reservation count', async () => {
  const f = fixture();
  for (let i = 0; i < 200; i++) await begin(f, new Uint8Array([97]));
  await expect(begin(f, new Uint8Array([97]))).rejects.toMatchObject({
    code: 'UPLOAD_STORAGE_LIMIT',
  });
  expect(f.bucket.put).not.toHaveBeenCalled();
});
