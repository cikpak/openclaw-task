import { afterEach, vi } from 'vitest';
import { Store } from '../src/database.js';
import { enqueue } from '../src/chats/queue.js';
import type { Gateway, GatewayHistory } from '../src/gateway/types.js';
import { FakeGateway, testSettings } from './fake-gateway.js';
import { ChatService, mapping } from '../src/chats/service.js';
const stores: Store[] = [];
const services: ChatService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) {
    service.close();
    await service.drain();
  }
  stores.splice(0).forEach((store) => store.close());
});
export function exactAbortFixture() {
  const store = new Store(':memory:');
  stores.push(store);
  const chat = {
    id: 'chat',
    name: 'Chat',
    status: 'running' as const,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    settings: testSettings,
    agentId: 'agent',
    sessionKey: 'agent:agent:main',
    creationId: 'create',
  };
  store.reserveChat(chat);
  const history: GatewayHistory = {
    messages: [],
    activeRun: { id: 'generated', text: '', sequence: 1 },
    hasOlderHistory: false,
    historyCursor: null,
    settings: testSettings,
    sessionId: 'native-session',
    nativeInputOwners: [],
    receipts: [],
  };
  const add = (id: string, owner = 'generated') => {
    const item = enqueue(store, {
      type: 'conversation.message.send',
      commandId: id,
      chatId: chat.id,
      text: `Exact accepted ${id}`,
    });
    item.state = 'submitted';
    store.savePending(item);
    store.saveSubmissionScope(id, history.sessionId!);
    history.nativeInputOwners!.push({
      inputId: item.submissionId,
      runId: owner,
    });
    return item;
  };
  const input = add('input');
  const abortRun = vi.fn((_mapping: unknown, owner: string) =>
    Promise.resolve({ abortedRunId: owner }),
  );
  const abort = vi.fn(() => {
    history.activeRun = null;
    return Promise.resolve({ abortedRunId: 'input' });
  });
  const gateway = {
    nativeAbortProofs: true,
    history: () => Promise.resolve(structuredClone(history)),
    abortRun,
    abort,
  } as unknown as Gateway;
  const proof = (id = 'input') =>
    store.db
      .prepare('SELECT * FROM pending_cancellations WHERE message_id=?')
      .get(id) as { confirmed: number; owner_run_id: string } | undefined;
  return { store, chat, history, input, add, abortRun, abort, gateway, proof };
}

export async function exactCallerFixture() {
  const store = new Store(':memory:');
  stores.push(store);
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  services.push(service);
  const created = await service.create({
    commandId: crypto.randomUUID(),
    settings: testSettings,
  });
  await service.drain();
  const chat = store.getChat(created.id);
  const input = enqueue(store, {
    type: 'conversation.message.send',
    commandId: 'input',
    chatId: chat.id,
    text: 'Exact accepted input',
  });
  input.state = 'submitted';
  store.savePending(input);
  const history = gateway.histories.get(mapping(chat).sessionKey)!;
  store.saveSubmissionScope(input.id, history.sessionId!);
  history.activeRun = { id: 'generated', text: '', sequence: 1 };
  history.receipts = [];
  history.nativeInputOwners = [
    { inputId: input.submissionId, runId: 'generated' },
  ];
  const abortRun = vi.fn(() => {
    history.activeRun = null;
    return Promise.resolve({ abortedRunId: 'generated' });
  });
  const abort = vi.fn(() => Promise.resolve({ abortedRunId: 'input' }));
  Object.assign(gateway, { nativeAbortProofs: true, abortRun, abort });
  return { store, gateway, service, chat, abortRun, abort };
}
