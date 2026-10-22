import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayProtocolRequestError } from '@openclaw/gateway-client/browser';
import type * as GatewaySdk from '@openclaw/gateway-client/browser';
import type {
  GatewayBrowserDeviceAuthPlan,
  GatewayProtocolClient,
} from '@openclaw/gateway-client/browser';
import type { GatewayEvent } from '../../../../backend/src/gateway/types.js';
import { NativeGateway } from './native.js';
import type { AuthStorage } from './identity.js';
type Options = ConstructorParameters<
  typeof GatewayProtocolClient<GatewayBrowserDeviceAuthPlan>
>[0];
const mock = vi.hoisted(() => ({
  clients: [] as Options[],
  requests: [] as { method: string; params: unknown }[],
  responses: new Map<string, unknown>(),
}));
vi.mock('@openclaw/gateway-client/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof GatewaySdk>();
  return {
    ...actual,
    GatewayProtocolClient: class {
      constructor(options: Options) {
        mock.clients.push(options);
      }
      start() {}
      stop() {}
      request(method: string, params: unknown) {
        mock.requests.push({ method, params });
        const response = mock.responses.get(method);
        if (response instanceof Error) return Promise.reject(response);
        return Promise.resolve(
          response ??
            (method === 'agents.files.get'
              ? { agentId: 'a', file: { name: 'AGENTS.md', missing: true } }
              : {}),
        );
      }
    },
  };
});
function storage(): AuthStorage {
  const rows = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Promise.resolve(rows.get(key) as T | undefined),
    put: (key, value) => {
      rows.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(rows.delete(key)),
  };
}
function gateway(store = storage(), pair = vi.fn(() => Promise.resolve())) {
  return new NativeGateway({
    fetcher: () => {
      throw new Error('The SDK mock must not open a network socket');
    },
    storage: store,
    gatewayToken: 'gateway-private-token',
    pair,
  });
}
async function connected(value: NativeGateway) {
  value.start();
  await vi.waitFor(() => expect(mock.clients.length).toBeGreaterThan(0));
  const client = mock.clients.at(-1)!;
  // Only the fields consumed by this adapter are necessary for the handshake observation.
  client.onHello?.({ policy: { maxPayload: 8388608 } } as Parameters<
    NonNullable<Options['onHello']>
  >[0]);
  await value.waitReady(100);
  value.dispatch(true);
  return client;
}
const mapping = { agentId: 'a', sessionKey: 'agent:a:main' };
afterEach(() => {
  mock.clients.length = 0;
  mock.requests.length = 0;
  mock.responses.clear();
});
describe('native SDK Gateway boundary', () => {
  it('persists exact signing identity across adapter recreation and can restart after stop', async () => {
    const store = storage();
    const first = gateway(store);
    const second = gateway(store);
    expect(await second.identity()).toEqual(await first.identity());
    const identity = await first.identity();
    expect(identity.scopes).toEqual([
      'operator.admin',
      'operator.read',
      'operator.write',
    ]);
    await connected(first);
    expect(first.ready).toBe(true);
    await first.stop();
    expect(first.ready).toBe(false);
    first.start();
    await vi.waitFor(() => expect(mock.clients.length).toBe(2));
    mock.clients[1]!.onHello?.({
      policy: { maxPayload: 8388608 },
    } as Parameters<NonNullable<Options['onHello']>>[0]);
    await first.waitReady(100);
    await first.stop();
  });
  it('ignores superseded SDK auth callbacks after a successful restart', async () => {
    const store = storage();
    const value = gateway(store);
    const old = await connected(value);
    await value.stop();
    value.start();
    await vi.waitFor(() => expect(mock.clients.length).toBe(2));
    mock.clients[1]!.onHello?.({
      policy: { maxPayload: 8388608 },
    } as Parameters<NonNullable<Options['onHello']>>[0]);
    await value.waitReady(100);
    value.dispatch(true);
    await store.put('deviceToken', {
      token: 'current-device-token',
      scopes: ['operator.read'],
    });
    await old.onConnectFailure?.(
      new GatewayProtocolRequestError({
        code: 'NOT_PAIRED',
        message: 'old auth failure',
      }),
      {} as Parameters<NonNullable<Options['onConnectFailure']>>[1],
    );
    await old.onConnectHello?.(
      { auth: { deviceToken: 'stale-device-token' } } as Parameters<
        NonNullable<Options['onConnectHello']>
      >[0],
      {} as Parameters<NonNullable<Options['onConnectHello']>>[1],
    );
    expect(value.ready).toBe(true);
    expect(await store.get('deviceToken')).toEqual({
      token: 'current-device-token',
      scopes: ['operator.read'],
    });
    await value.stop();
  });
  it('projects complete safe history before it can enter service caches', async () => {
    const value = gateway();
    await connected(value);
    mock.responses.set('chat.history', {
      sessionInfo: { model: 'model', modelProvider: 'provider' },
      messages: [
        { id: 'u', role: 'user', content: 'Hello' },
        {
          id: 'a',
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'private reasoning' },
            {
              type: 'text',
              text: 'Read /recovery/.openclaw/keys and gateway-private-token',
            },
          ],
        },
        { id: 't', role: 'toolResult', content: 'private tool output' },
        { id: 's', role: 'system', content: 'private system' },
      ],
    });
    const history = await value.history(mapping);
    expect(history.messages).toHaveLength(2);
    expect(history.messages[1]?.text).toBe(
      'Read [private reference] and [redacted]',
    );
    expect(history.tools).toEqual([]);
    expect(
      mock.requests.find((request) => request.method === 'chat.history')
        ?.params,
    ).toMatchObject({ limit: 1000, maxChars: 500000 });
    await value.stop();
  });
  it('rehydrates truncated native messages before caching and refuses incomplete replies', async () => {
    const value = gateway();
    await connected(value);
    mock.responses.set('chat.history', {
      sessionInfo: { model: 'model', modelProvider: 'provider' },
      messages: [
        {
          id: 'message',
          role: 'assistant',
          __openclaw: { id: 'message', truncated: true },
          content: 'short',
        },
      ],
    });
    const complete = 'full '.repeat(50000);
    mock.responses.set('chat.message.get', {
      ok: true,
      message: { id: 'message', role: 'assistant', content: complete },
    });
    expect((await value.history(mapping)).messages[0]?.text).toBe(complete);
    expect(
      mock.requests.find((request) => request.method === 'chat.message.get')
        ?.params,
    ).toMatchObject({ messageId: 'message', maxChars: 2000000 });
    mock.responses.set('chat.message.get', {
      ok: false,
      unavailableReason: 'oversized',
    });
    await expect(value.history(mapping)).rejects.toThrow();
    await value.stop();
  });
  it('recovers complete text through the exact private helper when native message transport rejects', async () => {
    const fullMessage = vi.fn(() =>
      Promise.resolve({
        id: 'full',
        role: 'assistant',
        content: 'Complete text',
      }),
    );
    const value = new NativeGateway({
      storage: storage(),
      gatewayToken: 'private-token',
      pair: () => Promise.resolve(),
      fetcher: () => {
        throw Error('SDK mocked');
      },
      fullMessage,
    });
    await connected(value);
    mock.responses.set('chat.history', {
      sessionInfo: { model: 'model', modelProvider: 'provider' },
      messages: [
        {
          id: 'full',
          role: 'assistant',
          content: 'truncated',
          __openclaw: { id: 'full', truncated: true },
        },
      ],
    });
    mock.responses.set(
      'chat.message.get',
      new Error('Native frame unavailable'),
    );
    expect((await value.history(mapping)).messages[0]?.text).toBe(
      'Complete text',
    );
    expect(fullMessage).toHaveBeenCalledWith(mapping, 'full');
    await value.stop();
  });
  it('holds split credentials and paths across live frames, suppressing raw tool events', async () => {
    const value = gateway();
    const client = await connected(value);
    const events: GatewayEvent[] = [];
    value.onEvent((event) => events.push(event));
    const send = (
      seq: number,
      text: string,
      state: 'delta' | 'final' = 'delta',
    ) =>
      client.onEvent?.({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: mapping.sessionKey,
          runId: 'r',
          seq,
          state,
          deltaText: text,
        },
      });
    send(1, 'Hello /rec');
    send(2, 'overy/private gateway-priv');
    send(3, 'ate-token done', 'final');
    client.onEvent?.({
      type: 'event',
      event: 'agent',
      payload: { stream: 'tool', data: { args: 'private raw tool arguments' } },
    });
    const text = events
      .flatMap((event) => (event.type === 'chat' ? [event.text] : []))
      .join('');
    expect(text).toBe('Hello [private reference] [redacted] done');
    expect(events).toHaveLength(3);
    await value.stop();
  });
});
