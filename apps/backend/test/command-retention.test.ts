import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationCommand } from '@messenger/contracts';
import { Store } from '../src/database.js';
import { ChatService, mapping } from '../src/chats/service.js';
import { FakeGateway, testSettings } from './fake-gateway.js';

const resources: { store: Store; service: ChatService }[] = [];
afterEach(async () => {
  for (const item of resources.splice(0)) {
    item.service.close();
    await item.service.drain();
    item.store.close();
  }
});
async function fixture() {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway);
  resources.push({ store, service });
  const chat = await service.create({
    commandId: randomUUID(),
    settings: testSettings,
  });
  await service.drain();
  const target = mapping(store.getChat(chat.id));
  (await gateway.history(target)).messages = [
    { id: 'large', role: 'assistant', text: 'x'.repeat(200_000), createdAt: 1 },
  ];
  return { store, gateway, service, chat };
}
it('does not retain repeated large snapshot/history results or read request identities in SQLite', async () => {
  const f = await fixture();
  for (let index = 0; index < 20; index++) {
    const type =
      index % 2
        ? 'conversation.snapshot.request'
        : 'conversation.history.request';
    const result = await f.service.command({
      type,
      commandId: randomUUID(),
      chatId: f.chat.id,
    });
    expect(result.ok).toBe(true);
  }
  expect(
    f.store.db.prepare('SELECT count(*) AS count FROM command_results').get(),
  ).toEqual({ count: 0 });
  expect(
    f.store.db.prepare('SELECT count(*) AS count FROM command_requests').get(),
  ).toEqual({ count: 0 });
  await f.service.delete(f.chat.id, `"${f.store.getChat(f.chat.id).version}"`);
  await f.service.drain();
  expect(
    f.store.db.prepare('SELECT count(*) AS count FROM command_results').get(),
  ).toEqual({ count: 0 });
});
it('retains mutation identities across restart and prevents read commands from reusing them', async () => {
  const f = await fixture();
  const command: ConversationCommand = {
    type: 'conversation.message.read',
    commandId: randomUUID(),
    chatId: f.chat.id,
  };
  const result = await f.service.command(command);
  expect(f.store.getCommand(command.commandId)).toEqual(result);
  const duplicate = await f.service.command({
    type: 'conversation.snapshot.request',
    commandId: command.commandId,
    chatId: f.chat.id,
  });
  expect(duplicate).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_ID_REUSED' },
  });
});
it('removes only provably read-only legacy caches while preserving all mutation and ambiguous receipts', () => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'messenger-retention-')),
    'data.sqlite',
  );
  let store = new Store(path);
  store.db.prepare('DELETE FROM migrations WHERE version = 3').run();
  const chatId = randomUUID();
  const readIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of readIds.entries()) {
    if (index < 2)
      store.saveCommandRequest(
        id,
        JSON.stringify({
          type: index
            ? 'conversation.history.request'
            : 'conversation.snapshot.request',
          commandId: id,
          chatId,
        }),
      );
    store.saveCommand({
      type: 'command.result',
      commandId: id,
      ok: true,
      data: {
        messages: [
          {
            id: 'large',
            role: 'assistant',
            text: 'x'.repeat(200_000),
            createdAt: 1,
          },
        ],
      },
    });
  }
  const mutationIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of mutationIds.entries()) {
    store.saveCommandRequest(
      id,
      JSON.stringify({
        type: [
          'conversation.message.send',
          'conversation.run.abort',
          'conversation.message.read',
        ][index],
        commandId: id,
        chatId,
      }),
    );
    store.saveCommand({
      type: 'command.result',
      commandId: id,
      ok: true,
      data: {},
    });
  }
  const ambiguousId = randomUUID();
  store.saveCommand({
    type: 'command.result',
    commandId: ambiguousId,
    ok: true,
    data: {},
  });
  store.close();
  store = new Store(path);
  try {
    for (const id of readIds.slice(0, 2)) {
      expect(store.getCommand(id) === null).toBe(true);
      expect(store.commandRequest(id)).toBeNull();
    }
    // A result shape alone never proves the operation was read-only.
    expect(store.getCommand(readIds[2] ?? '')?.ok).toBe(true);
    for (const id of [...mutationIds, ambiguousId])
      expect(store.getCommand(id)?.ok).toBe(true);
    for (const id of mutationIds)
      expect(store.commandRequest(id)).not.toBeNull();
    expect(
      store.db
        .prepare('SELECT count(*) AS count FROM migrations WHERE version = 3')
        .get(),
    ).toEqual({ count: 1 });
  } finally {
    store.close();
  }
});
