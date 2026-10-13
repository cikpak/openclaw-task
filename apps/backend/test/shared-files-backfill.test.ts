import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Attachment,
  ConversationCommand,
  PendingMessage,
} from '@messenger/contracts';
import { Store } from '../src/database.js';
import { UploadService } from '../src/uploads/service.js';
import { sharedFiles } from '../src/uploads/shared-files.js';
import { GatewayUnavailableError } from '../src/errors.js';
import { FakeGateway, testSettings } from './fake-gateway.js';
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.restoreAllMocks();
});
async function fixture() {
  const store = new Store(':memory:');
  stores.push(store);
  const gateway = new FakeGateway();
  const uploads = new UploadService(
    store,
    mkdtempSync(join(tmpdir(), 'shared-backfill-')),
    'owner',
    gateway,
  );
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
    Buffer.from('Old file'),
    'text/plain',
    'old.txt',
  );
  const history = gateway.histories.get(target.sessionKey);
  if (!history) throw new Error('Missing history');
  const acknowledge = (command: ConversationCommand, messageId?: string) => {
    store.saveCommandRequest(command.commandId, JSON.stringify(command));
    store.saveCommand({
      type: 'command.result',
      commandId: command.commandId,
      ok: true,
      data: messageId ? { messageId } : {},
    });
  };
  const send = (uploadIds: string[] = [file.uploadId]) => {
    const id = randomUUID();
    acknowledge(
      {
        type: 'conversation.message.send',
        commandId: id,
        chatId,
        text: 'Input',
        uploadIds,
      },
      id,
    );
    return id;
  };
  return { store, gateway, uploads, chatId, file, history, acknowledge, send };
}
it('backfills exact recent sends only after authoritative native acceptance and is idempotent', async () => {
  const f = await fixture();
  const id = f.send();
  f.history.receipts.push({ runId: 'different', state: 'consumed' });
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([]);
  f.history.receipts.push({ runId: id, state: 'pending' });
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([
    f.file,
  ]);
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([
    f.file,
  ]);
  expect(
    f.store.db
      .prepare('SELECT count(*) AS count FROM shared_input_files')
      .get(),
  ).toEqual({ count: 1 });
  expect(
    await sharedFiles(f.store, f.gateway, 'another-owner', f.chatId),
  ).toEqual([]);
});
it('applies exact successful attachment edits and excludes canceled, discarded and failed requests', async () => {
  const f = await fixture();
  const replacement = await f.uploads.create(
    Buffer.from('Replacement'),
    'text/plain',
    'new.txt',
  );
  const edited = f.send();
  f.acknowledge(
    {
      type: 'conversation.message.editQueued',
      commandId: randomUUID(),
      chatId: f.chatId,
      messageId: edited,
      revision: 1,
      text: 'Revised',
      uploadIds: [replacement.uploadId],
    },
    edited,
  );
  const cancelled = f.send();
  f.acknowledge(
    {
      type: 'conversation.message.cancelQueued',
      commandId: randomUUID(),
      chatId: f.chatId,
      messageId: cancelled,
      revision: 1,
    },
    cancelled,
  );
  const discarded = f.send();
  f.acknowledge({
    type: 'conversation.message.resolveUnknown',
    commandId: randomUUID(),
    chatId: f.chatId,
    messageId: discarded,
    revision: 1,
    action: 'discard',
  });
  const failed = randomUUID();
  f.store.saveCommandRequest(
    failed,
    JSON.stringify({
      type: 'conversation.message.send',
      commandId: failed,
      chatId: f.chatId,
      text: 'Failed',
      uploadIds: [f.file.uploadId],
    }),
  );
  f.store.saveCommand({
    type: 'command.result',
    commandId: failed,
    ok: false,
    error: {
      type: 'about:blank',
      title: 'Failure',
      status: 503,
      detail: 'Fixture',
      code: 'UNAVAILABLE',
      correlationId: randomUUID(),
    },
  });
  f.history.receipts.push(
    ...[edited, cancelled, discarded, failed].map((runId) => ({
      runId,
      state: 'consumed' as const,
    })),
  );
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([
    replacement,
  ]);
});
it('fails closed on mutation history beyond the bounded window rather than missing later cancellation', async () => {
  const f = await fixture();
  const id = f.send();
  for (let i = 0; i < 100; i++)
    f.acknowledge(
      {
        type: 'conversation.message.editQueued',
        commandId: randomUUID(),
        chatId: f.chatId,
        messageId: id,
        revision: i + 1,
        text: 'Edit',
        uploadIds: [f.file.uploadId],
      },
      id,
    );
  f.acknowledge(
    {
      type: 'conversation.message.cancelQueued',
      commandId: randomUUID(),
      chatId: f.chatId,
      messageId: id,
      revision: 101,
    },
    id,
  );
  f.history.receipts.push({ runId: id, state: 'consumed' });
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([]);
});
it('does not infer ambiguous initial creation files or recover expired legacy bytes', async () => {
  const f = await fixture();
  f.store.saveCreationCommand(randomUUID(), f.chatId, {
    settings: testSettings,
    initialMessage: { text: 'Initial', uploadIds: [f.file.uploadId] },
  });
  f.history.receipts.push({ runId: randomUUID(), state: 'consumed' });
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([]);
  const id = f.send();
  f.history.receipts.push({ runId: id, state: 'consumed' });
  f.store.db.prepare('UPDATE uploads SET expires_at=0').run();
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([]);
});
it('returns cached confirmed metadata through known connection loss but propagates unexpected errors', async () => {
  const f = await fixture();
  const item: PendingMessage = {
    id: randomUUID(),
    chatId: f.chatId,
    position: 1,
    text: 'Accepted',
    attachments: [f.file],
    revision: 1,
    state: 'submitted',
    submissionId: randomUUID(),
    createdAt: 1,
  };
  f.store.savePending(item);
  f.store.removePending(item.id);
  const candidate: Attachment = await f.uploads.create(
    Buffer.from('Candidate'),
    'text/plain',
    'candidate.txt',
  );
  f.send([candidate.uploadId]);
  const history = vi
    .spyOn(f.gateway, 'history')
    .mockRejectedValue(new GatewayUnavailableError());
  expect(await sharedFiles(f.store, f.gateway, 'owner', f.chatId)).toEqual([
    f.file,
  ]);
  history.mockRejectedValue(new Error('Unexpected receipt error'));
  await expect(
    sharedFiles(f.store, f.gateway, 'owner', f.chatId),
  ).rejects.toThrow('Unexpected receipt error');
});
