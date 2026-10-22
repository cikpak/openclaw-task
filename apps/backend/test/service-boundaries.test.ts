import { afterEach, expect, it, vi } from 'vitest';
import { ChatService, mapping } from '../src/chats/service.js';
import { Store } from '../src/database.js';
import { FakeGateway, testSettings } from './fake-gateway.js';

const resources: { service: ChatService; store: Store }[] = [];
afterEach(async () => {
  for (const { service, store } of resources.splice(0)) {
    service.close();
    await service.drain();
    store.close();
  }
  vi.restoreAllMocks();
});

it('serves complete cached conversation without consulting a ready engine', async () => {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  resources.push({ store, service });
  const chat = await service.create({
    commandId: crypto.randomUUID(),
    settings: testSettings,
  });
  await service.drain();
  const history = await gateway.history(mapping(store.getChat(chat.id)));
  history.messages = [
    {
      id: 'complete-reply',
      role: 'assistant',
      createdAt: 1,
      text: 'A complete reply. '.repeat(10_000),
    },
  ];
  const expected = await service.snapshot(chat.id);
  const read = vi.spyOn(gateway, 'history');
  const start = vi.spyOn(gateway, 'start');
  expect(service.cachedSnapshot(chat.id).messages).toEqual(expected.messages);
  expect(
    (await service.snapshot(chat.id, { refresh: false })).messages,
  ).toEqual(expected.messages);
  expect(read).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  gateway.ready = false;
  expect(service.cachedSnapshot(chat.id).messages[0]?.text).toBe(
    history.messages[0]?.text,
  );
});

it('allows Durable Object alarms to own recovery without a process interval', () => {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const interval = vi.spyOn(globalThis, 'setInterval');
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  resources.push({ store, service });
  expect(interval).not.toHaveBeenCalled();
});
