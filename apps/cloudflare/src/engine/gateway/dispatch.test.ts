import { afterEach, expect, it, vi } from 'vitest';
import type * as SDK from '@openclaw/gateway-client/browser';
import type {
  GatewayBrowserDeviceAuthPlan,
  GatewayProtocolClient,
} from '@openclaw/gateway-client/browser';
import { Store } from '../../../../backend/src/database.js';
import { ChatService } from '../../../../backend/src/chats/service.js';
import { enqueue } from '../../../../backend/src/chats/queue.js';
import { settingsSchema } from '../../../../backend/src/schemas.js';
import { NativeGateway, type AuthStorage } from './native.js';

type Options = ConstructorParameters<
  typeof GatewayProtocolClient<GatewayBrowserDeviceAuthPlan>
>[0];
const mock = vi.hoisted(() => ({
  clients: [] as Options[],
  calls: [] as { method: string; params: unknown }[],
}));
vi.mock('@openclaw/gateway-client/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof SDK>();
  return {
    ...actual,
    GatewayProtocolClient: class {
      constructor(options: Options) {
        mock.clients.push(options);
      }
      start() {}
      stop() {}
      request(method: string, params: unknown) {
        mock.calls.push({ method, params });
        if (method === 'chat.history')
          return Promise.resolve({
            sessionId: 'native-session',
            sessionInfo: { model: 'model', modelProvider: 'provider' },
            messages: [
              {
                role: 'user',
                content: 'Already executing',
                __openclaw: {
                  id: 'old-user',
                  seq: 1,
                  idempotencyKey: 'old:user',
                },
              },
              {
                role: 'assistant',
                content: 'Finished',
                stopReason: 'stop',
                __openclaw: { id: 'old-final', seq: 2, runId: 'old' },
              },
            ],
            inputReceipts: [
              {
                runId: 'old',
                state: 'consumed',
                consumedByEventId: 'old-user',
              },
            ],
            hasMore: false,
          });
        if (method === 'agents.files.get')
          return Promise.resolve({
            agentId: 'a',
            file: { name: 'AGENTS.md', missing: true },
          });
        if (method === 'chat.send')
          return Promise.resolve({
            runId: (params as { idempotencyKey: string }).idempotencyKey,
            status: 'started',
          });
        if (method === 'sessions.title.prepare')
          return Promise.resolve({ title: null });
        return Promise.resolve({});
      }
    },
  };
});
const resources: {
  gateway: NativeGateway;
  store: Store;
  service: ChatService;
}[] = [];
afterEach(async () => {
  for (const { gateway, store, service } of resources.splice(0)) {
    service.close();
    await service.drain();
    await gateway.stop();
    store.close();
  }
  mock.clients.length = 0;
  mock.calls.length = 0;
});

it('native terminal events cannot dispatch accepted work across suspension while manager acceptance remains durable', async () => {
  const rows = new Map<string, unknown>();
  const storage: AuthStorage = {
    get: <T>(key: string) => Promise.resolve(rows.get(key) as T | undefined),
    put: (key, value) => {
      rows.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(rows.delete(key)),
  };
  const gateway = new NativeGateway({
    storage,
    gatewayToken: 'private-gateway-token',
    pair: () => Promise.resolve(),
    fetcher: () => {
      throw Error('Network is replaced by the SDK boundary fixture');
    },
  });
  const store = new Store(':memory:');
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  resources.push({ gateway, store, service });
  const settings = settingsSchema.parse({
    model: 'provider/model',
    thinkingLevel: 'off',
    fastMode: false,
  });
  const now = Date.now();
  store.reserveChat({
    id: 'chat',
    name: 'Chat',
    status: 'running',
    version: 1,
    createdAt: now,
    updatedAt: now,
    unread: false,
    settings,
    agentId: 'a',
    sessionKey: 'agent:a:main',
    creationId: 'creation',
  });
  const old = enqueue(store, {
    type: 'conversation.message.send',
    commandId: 'old',
    chatId: 'chat',
    text: 'Already executing',
  });
  old.state = 'submitted';
  store.savePending(old);
  store.saveSubmissionScope(old.id, 'native-session');
  gateway.start();
  await vi.waitFor(() => expect(mock.clients).toHaveLength(1));
  const client = mock.clients[0]!;
  client.onHello?.({ policy: { maxPayload: 8388608 } } as Parameters<
    NonNullable<Options['onHello']>
  >[0]);
  await gateway.waitReady(100);
  expect(gateway.ready).toBe(false);
  gateway.dispatch(false);
  const accepted = enqueue(store, {
    type: 'conversation.message.send',
    commandId: 'new',
    chatId: 'chat',
    text: 'Accepted while sleeping',
  });
  expect(store.getCommand(accepted.id)?.ok).toBe(true);
  client.onEvent?.({
    type: 'event',
    event: 'chat',
    payload: {
      sessionKey: 'agent:a:main',
      runId: 'old',
      seq: 3,
      state: 'final',
      deltaText: 'Finished',
    },
  });
  await vi.waitFor(() =>
    expect(store.pending('chat').find((item) => item.id === 'old')?.state).toBe(
      'unknown',
    ),
  );
  await service.drain();
  expect(mock.calls.filter((call) => call.method === 'chat.send')).toEqual([]);
  expect(store.pending('chat').map((item) => item.id)).toEqual(['old', 'new']);
  expect(store.pending('chat').find((item) => item.id === 'new')?.state).toBe(
    'pending',
  );
  await gateway.request('gateway.suspend.prepare', {
    requestId: 'attempt',
    drain: true,
  });
  expect(
    mock.calls.some((call) => call.method === 'gateway.suspend.prepare'),
  ).toBe(true);
  gateway.dispatch(true);
  await vi.waitFor(() =>
    expect(
      mock.calls.filter((call) => call.method === 'chat.send'),
    ).toHaveLength(1),
  );
  await service.drain();
  expect(store.pending('chat').map((item) => item.id)).toEqual(['new']);
  expect(store.pending('chat')[0]?.state).toBe('submitted');
  expect(
    mock.calls.find((call) => call.method === 'chat.send')?.params,
  ).toMatchObject({ idempotencyKey: 'new' });
});
