import { afterEach, expect, it } from 'vitest';
import { Store } from '../../../backend/src/database.js';
import { ChatService } from '../../../backend/src/chats/service.js';
import {
  FakeGateway,
  normalizedTestSettings,
} from '../../../backend/test/fake-gateway.js';
import { enqueue } from '../../../backend/src/chats/queue.js';
import { materializeChats } from './creation.js';
import { validateCachedCreation } from '../manager/creation-validation.js';
const closes: (() => void)[] = [];
afterEach(() => closes.splice(0).forEach((close) => close()));
it('never accepts the unconfigured sentinel as a native model', () => {
  const store = new Store(':memory:');
  closes.push(() => store.close());
  expect(() =>
    validateCachedCreation(store, {
      ...normalizedTestSettings,
      model: 'unconfigured',
    }),
  ).toThrow('model options changed');
});
it('retains initial accepted work and exposes recovery after deferred model validation fails', async () => {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  closes.push(() => {
    service.close();
    store.close();
  });
  const id = crypto.randomUUID();
  store.reserveChat({
    id,
    name: 'Retained work',
    status: 'creating',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    settings: { ...normalizedTestSettings, model: 'unknown/model' },
    agentId: null,
    sessionKey: null,
    creationId: crypto.randomUUID(),
  });
  enqueue(store, {
    type: 'conversation.message.send',
    commandId: crypto.randomUUID(),
    chatId: id,
    text: 'Keep this original work',
  });
  await materializeChats(store, gateway, service);
  expect(store.getChat(id).status).toBe('recovery');
  expect(store.getChat(id).agentId).toBeNull();
  expect(store.pending(id).map((item) => item.text)).toEqual([
    'Keep this original work',
  ]);
  await materializeChats(store, gateway, service);
  expect(store.pending(id)).toHaveLength(1);
});
