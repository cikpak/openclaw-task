import { afterEach, expect, it } from 'vitest';
import { Store } from '../../../backend/src/database.js';
import { modelCache } from './cached-models.js';
import { CachedCommands } from './cached-commands.js';
import { ManagerAuthorization } from './authorization.js';
import type { ManagerEnv } from './types.js';
import type { ModelCapability } from '@messenger/contracts';
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
it('does not fabricate an initial catalog and persists exact per-scope native capabilities', () => {
  const store = new Store(':memory:');
  stores.push(store);
  const first = modelCache(store);
  expect(first.read()).toEqual([]);
  const models: ModelCapability[] = [
    {
      id: 'provider/model',
      name: 'Native name',
      provider: 'provider',
      available: false,
      thinkingLevels: [{ id: 'off', label: 'Off' }],
      thinkingDefault: 'off',
      supportsFastMode: false,
      fastModeSupport: 'unknown',
      input: ['text'],
    },
  ];
  first.save(models, 'chat');
  expect(modelCache(store).read('chat')).toEqual(models);
  expect(modelCache(store).read()).toEqual([]);
  const cache = new CachedCommands(
    store,
    new ManagerAuthorization({} as ManagerEnv, store),
    undefined,
  );
  expect(
    cache.read(
      {
        type: 'models.list',
        commandId: crypto.randomUUID(),
        chatId: 'chat',
        cachedOnly: true,
      },
      'owner',
    ),
  ).toEqual({ models });
  expect(
    cache.read(
      {
        type: 'models.list',
        commandId: crypto.randomUUID(),
        cachedOnly: false,
      },
      'owner',
    ),
  ).toBeUndefined();
});
it('returns omitted cached whole messages before delegating older native history', () => {
  const store = new Store(':memory:');
  stores.push(store);
  const id = crypto.randomUUID();
  store.reserveChat({
    id,
    name: 'History',
    status: 'idle',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    settings: { model: 'p/m', thinkingLevel: 'off', fastMode: false },
    agentId: null,
    sessionKey: null,
    creationId: crypto.randomUUID(),
  });
  const messages = Array.from({ length: 50 }, (_, index) => ({
    id: `message-${index}`,
    role: 'assistant' as const,
    text: index === 49 ? 'z'.repeat(2530000) : `whole ${index}`,
    createdAt: index + 1,
  }));
  store.db
    .prepare('INSERT INTO chat_history (chat_id, json) VALUES (?, ?)')
    .run(
      id,
      JSON.stringify({
        chat: store.getChat(id),
        messages,
        pending: [],
        activeRun: null,
        pendingSettings: null,
        historyCursor: 'native-older',
        hasOlderHistory: true,
      }),
    );
  const cache = new CachedCommands(
    store,
    new ManagerAuthorization({} as ManagerEnv, store),
    undefined,
  );
  const recent = cache.read(
    {
      type: 'conversation.recent.request',
      commandId: crypto.randomUUID(),
      chatId: id,
      viewport: { width: 360, height: 500, fontSize: 16, lineHeight: 24 },
    },
    'owner',
  )!;
  expect(recent.snapshot?.messages).toEqual([messages[49]]);
  expect(recent.snapshot?.messages[0]?.text).toHaveLength(2530000);
  expect(recent.snapshot?.historyCursor).toBe('cache:message-49');
  const older = cache.read(
    {
      type: 'conversation.history.request',
      commandId: crypto.randomUUID(),
      chatId: id,
      cursor: recent.snapshot!.historyCursor!,
    },
    'owner',
  )!;
  expect(older.messages).toEqual(messages.slice(0, 49));
  expect(older.historyCursor).toBe('native-older');
  expect(older.hasOlderHistory).toBe(true);
});

it('marks cached unread content without an engine and never repeats an old read over newly unread work', () => {
  const store = new Store(':memory:');
  stores.push(store);
  const id = crypto.randomUUID();
  store.reserveChat({
    id,
    name: 'Unread',
    status: 'idle',
    version: 7,
    createdAt: 1,
    updatedAt: 1,
    unread: true,
    settings: { model: 'p/m', thinkingLevel: 'off', fastMode: false },
    agentId: null,
    sessionKey: null,
    creationId: crypto.randomUUID(),
  });
  const cache = new CachedCommands(
    store,
    new ManagerAuthorization({} as ManagerEnv, store),
    undefined,
  );
  const command = {
    type: 'conversation.message.read' as const,
    commandId: crypto.randomUUID(),
    chatId: id,
  };
  const result = cache.read(command, 'owner');
  expect(result?.chat?.unread).toBe(false);
  expect(store.getChat(id).unread).toBe(false);
  expect(store.getChat(id).version).toBe(7);
  store.saveChat({ ...store.getChat(id), unread: true });
  expect(cache.read(command, 'owner')).toEqual(result);
  expect(store.getChat(id).unread).toBe(true);
});
