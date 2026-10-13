import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attachment, PendingMessage } from '@messenger/contracts';
import { Store } from '../src/database.js';
import { UploadService } from '../src/uploads/service.js';
import { sharedFiles } from '../src/uploads/shared-files.js';
import { reconcileInputs } from '../src/chats/queue.js';
import { FakeGateway, testSettings } from './fake-gateway.js';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'messenger-shared-'));
  const path = join(directory, 'db.sqlite');
  const store = new Store(path);
  stores.push(store);
  const gateway = new FakeGateway();
  const uploads = new UploadService(store, directory, 'owner', gateway);
  const chatId = randomUUID();
  const target = await gateway.create(chatId, testSettings);
  store.reserveChat({
    id: chatId,
    name: 'Chat',
    status: 'idle',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    settings: testSettings,
    ...target,
    creationId: randomUUID(),
  });
  const file = await uploads.create(
    Buffer.from('Fixture'),
    'text/plain',
    'note.txt',
  );
  let position = 0;
  const pending = (
    attachments: Attachment[] = [file],
    state: PendingMessage['state'] = 'pending',
  ): PendingMessage => ({
    id: randomUUID(),
    chatId,
    position: ++position,
    text: 'Input',
    attachments,
    revision: 1,
    state,
    submissionId: randomUUID(),
    createdAt: Date.now() + position,
  });
  return {
    store,
    gateway,
    uploads,
    chatId,
    target,
    path,
    file,
    pending,
    directory,
  };
}
it('publishes only accepted files, preserves terminal/abort metadata, and isolates owners/chats', async () => {
  const f = await fixture();
  const item = f.pending();
  f.store.savePending(item);
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([]);
  item.state = 'submitted';
  f.store.savePending(item);
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([
    f.file,
  ]);
  f.store.removePending(item.id);
  f.gateway.histories.get(f.target.sessionKey)?.receipts.push({
    runId: item.submissionId,
    state: 'consumed',
    cancelled: true,
  });
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([
    f.file,
  ]);
  expect(
    await sharedFiles(f.store, f.gateway, 'other-owner', f.chatId),
  ).toEqual([]);
  const other = randomUUID();
  const target = await f.gateway.create(other, testSettings);
  f.store.reserveChat({
    ...f.store.getChat(f.chatId),
    id: other,
    ...target,
    creationId: randomUUID(),
  });
  expect(await sharedFiles(f.store, f.gateway, 'owner', other)).toEqual([]);
});
it('handles edits, never-accepted cancellations and unknown recovery without claiming sharing', async () => {
  const f = await fixture();
  const item = f.pending();
  f.store.savePending(item);
  const revised = await f.uploads.create(
    Buffer.from('Revised'),
    'text/plain',
    'revised.txt',
  );
  item.attachments = [revised];
  f.store.savePending(item);
  expect(
    f.store.db.prepare('SELECT upload_id FROM shared_input_files').all(),
  ).toEqual([{ upload_id: revised.uploadId }]);
  item.state = 'unknown';
  f.store.savePending(item);
  f.gateway.histories
    .get(f.target.sessionKey)
    ?.receipts.push({ runId: item.submissionId, state: 'consumed' });
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([]);
  f.store.removePending(item.id);
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([]);
  const cancelled = f.pending();
  cancelled.state = 'submitting';
  f.store.savePending(cancelled);
  const history = f.gateway.histories.get(f.target.sessionKey);
  if (!history) throw new Error('Missing fixture');
  history.receipts = [
    { runId: cancelled.submissionId, state: 'pending', cancelled: true },
  ];
  reconcileInputs(f.store, f.chatId, history);
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([]);
});
it('retains fast consumed inputs before send acknowledgement and private terminal outcomes need exact receipts', async () => {
  const f = await fixture();
  const item = f.pending([f.file], 'submitting');
  f.store.savePending(item);
  const history = f.gateway.histories.get(f.target.sessionKey);
  if (!history) throw new Error('Missing fixture');
  history.receipts = [{ runId: item.submissionId, state: 'consumed' }];
  reconcileInputs(f.store, f.chatId, history);
  f.gateway.ready = false;
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([
    f.file,
  ]);
  const other = await f.uploads.create(
    Buffer.from('Second'),
    'text/plain',
    'second.txt',
  );
  const terminal = f.pending([other], 'submitting');
  f.store.savePending(terminal);
  f.store.removePending(terminal.id);
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([
    f.file,
  ]);
  f.gateway.ready = true;
  history.receipts.push({ runId: terminal.submissionId, state: 'pending' });
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([
    other,
    f.file,
  ]);
});
it('survives restart and expired-byte cleanup without extending retention or exposing a download', async () => {
  const f = await fixture();
  const item = f.pending([f.file], 'submitted');
  f.store.savePending(item);
  f.store.removePending(item.id);
  f.store.db.prepare('UPDATE uploads SET expires_at=0').run();
  await f.uploads.cleanup();
  expect(f.store.db.prepare('SELECT id FROM uploads').all()).toEqual([]);
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  const restarted = new Store(f.path);
  stores.push(restarted);
  new UploadService(restarted, f.directory, 'owner', f.gateway);
  f.gateway.ready = false;
  expect(await sharedFiles(restarted, f.gateway, 'owner', f.chatId)).toEqual([
    f.file,
  ]);
  restarted.removeChat(f.chatId);
  expect(
    restarted.db.prepare('SELECT * FROM shared_input_files').all(),
  ).toEqual([]);
});
it('bounds durable metadata and catalog to the newest 100 files and deduplicates repeated shares', async () => {
  const f = await fixture();
  for (let i = 0; i < 101; i++) {
    const file = { ...f.file, uploadId: randomUUID(), name: `file-${i}.txt` };
    f.store.db
      .prepare('INSERT INTO uploads VALUES (?,?,?,?,?,?)')
      .run(
        file.uploadId,
        'owner',
        file.name,
        file.mimeType,
        file.size,
        Date.now() + 10000,
      );
    const item = f.pending([file], 'submitted');
    f.store.savePending(item);
    f.store.removePending(item.id);
  }
  f.gateway.ready = false;
  const files = await sharedFiles(f.store, f.gateway, 'owner', f.chatId);
  expect(files).toHaveLength(100);
  expect(files[0]?.name).toBe('file-100.txt');
  expect(files.some((file) => file.name === 'file-0.txt')).toBe(false);
  const duplicate = f.pending([files[0]!], 'submitted');
  f.store.savePending(duplicate);
  f.store.removePending(duplicate.id);
  expect(
    (await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).filter(
      (file) => file.uploadId === files[0]?.uploadId,
    ),
  ).toHaveLength(1);
});
it('does not hide unexpected receipt failures or resurrect metadata from deleted chats', async () => {
  const f = await fixture();
  const item = f.pending([f.file], 'submitting');
  f.store.savePending(item);
  f.store.removePending(item.id);
  vi.spyOn(f.gateway, 'history').mockRejectedValue(
    new Error('Unexpected fixture failure'),
  );
  await expect(
    sharedFiles(f.store, f.gateway, 'owner', f.chatId),
  ).rejects.toThrow('Unexpected fixture failure');
  const chat = f.store.getChat(f.chatId);
  chat.status = 'deleting';
  f.store.saveChat(chat);
  await expect(
    sharedFiles(f.store, f.gateway, 'owner', f.chatId),
  ).rejects.toMatchObject({ status: 404 });
});
