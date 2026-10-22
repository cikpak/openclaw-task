import { afterEach, expect, it } from 'vitest';
import { Store } from '../../../backend/src/database.js';
import { pruneCachedSnapshot, rememberViewport } from './cached-window.js';
import type { ChatSnapshot, Message } from '@messenger/contracts';
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function setup() {
  const store = new Store(':memory:');
  stores.push(store);
  const chat = {
    id: crypto.randomUUID(),
    name: 'Cache',
    status: 'idle' as const,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    settings: { model: 'p/m', thinkingLevel: 'off', fastMode: false },
  };
  store.reserveChat({
    ...chat,
    agentId: null,
    sessionKey: null,
    creationId: crypto.randomUUID(),
  });
  const messages: Message[] = Array.from({ length: 80 }, (_, index) => ({
    id: `message-${index}`,
    role: 'assistant',
    text: 'a'.repeat(180),
    createdAt: index + 1,
    historySequence: index + 1,
  }));
  const snapshot: ChatSnapshot = {
    chat,
    messages,
    pending: [],
    activeRun: null,
    pendingSettings: null,
    historyCursor: 'older:80',
    hasOlderHistory: true,
  };
  return { store, snapshot };
}
it('persists measured mobile/desktop windows without a fixed message count', () => {
  const { store, snapshot } = setup();
  rememberViewport(store, snapshot.chat.id, {
    width: 320,
    height: 500,
    fontSize: 16,
    lineHeight: 27.2,
  });
  const mobile = pruneCachedSnapshot(store, snapshot);
  rememberViewport(store, snapshot.chat.id, {
    width: 816,
    height: 900,
    fontSize: 16,
    lineHeight: 27.2,
  });
  const desktop = pruneCachedSnapshot(store, snapshot);
  expect(mobile.messages.length).toBeLessThan(desktop.messages.length);
  expect(desktop.messages.length).toBeLessThan(80);
  expect(pruneCachedSnapshot(store, snapshot)).toEqual(desktop);
  expect(mobile.historyCursor).toBe(
    `before:${mobile.messages[0]!.historySequence!}`,
  );
});
it('retains an entire oversized completed message and all native projection siblings', () => {
  const { store, snapshot } = setup();
  snapshot.messages.push(
    {
      id: 'sibling-a',
      role: 'user',
      text: 'user',
      createdAt: 100,
      historySequence: 81,
    },
    {
      id: 'sibling-b',
      role: 'assistant',
      text: 'x'.repeat(2530000),
      createdAt: 101,
      historySequence: 81,
    },
  );
  const result = pruneCachedSnapshot(store, snapshot);
  expect(result.messages.map((message) => message.id)).toEqual([
    'sibling-a',
    'sibling-b',
  ]);
  expect(result.messages[1]!.text).toHaveLength(2530000);
  expect(result.historyCursor).toBe('before:81');
});
it('keeps an unanchored legacy page intact rather than skipping its trimmed content', () => {
  const { store, snapshot } = setup();
  snapshot.messages = snapshot.messages.map(
    ({ historySequence: _sequence, ...message }) => {
      void _sequence;
      return message;
    },
  );
  expect(pruneCachedSnapshot(store, snapshot)).toEqual(snapshot);
});
