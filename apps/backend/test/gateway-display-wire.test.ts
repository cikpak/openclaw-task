import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayClientOptions } from '@openclaw/gateway-client';
import type { Config } from '../src/config.js';
import type { GatewayEvent } from '../src/gateway/types.js';
import { nativeAgentFileRequest } from './native-agent-files.js';

const transport = vi.hoisted(
  (): {
    options: GatewayClientOptions | null;
    responses: Record<string, unknown>;
    files: Map<string, string>;
  } => ({ options: null, responses: {}, files: new Map() }),
);
vi.mock('@openclaw/gateway-client', () => ({
  GatewayClient: class {
    constructor(options: GatewayClientOptions) {
      transport.options = options;
    }
    start(): void {}
    stopAndWait(): Promise<void> {
      return Promise.resolve();
    }
    request(method: string, params: unknown): Promise<unknown> {
      if (method === 'agents.files.get' || method === 'agents.files.set')
        return Promise.resolve(
          Object.hasOwn(transport.responses, method)
            ? transport.responses[method]
            : nativeAgentFileRequest(transport.files, method, params),
        );
      if (!Object.hasOwn(transport.responses, method))
        throw new Error(`Unexpected native RPC: ${method}`);
      return Promise.resolve(transport.responses[method]);
    }
  },
}));
import { OpenClawGateway } from '../src/gateway/openclaw.js';
const gateways: OpenClawGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  transport.responses = {};
  transport.files.clear();
});
function fixture() {
  const config: Config = {
    trustProxyHops: 0,
    host: 'localhost',
    port: 3000,
    dataDir: mkdtempSync(join(tmpdir(), 'messenger-display-')),
    origin: 'https://localhost',
    secureCookies: true,
    username: 'owner',
    passwordHash: '',
    sessionKey: Buffer.alloc(32),
    sessionLifetimeSeconds: 86400,
    gatewayUrl: 'wss://localhost:18789',
    gatewayToken: 'fixture-token',
    gatewayTlsFingerprint: 'AA'.repeat(32),
  };
  const gateway = new OpenClawGateway(config);
  gateways.push(gateway);
  gateway.start();
  gateway.ready = true;
  return gateway;
}
it('distinguishes omitted speed support from verified false and true without enabling unknown Fast', async () => {
  const gateway = fixture();
  const model = {
    id: 'model',
    name: 'Model',
    provider: 'test',
    thinkingLevels: [{ id: 'low', label: 'Low' }],
    thinkingDefault: 'low',
  };
  transport.responses['models.list'] = {
    models: [
      model,
      { ...model, id: 'unsupported', supportsFastMode: false },
      { ...model, id: 'supported', supportsFastMode: true },
    ],
  };
  expect(
    (await gateway.models()).map((item) => [
      item.supportsFastMode,
      item.fastModeSupport,
      item.thinkingDefault,
    ]),
  ).toEqual([
    [false, 'unknown', 'low'],
    [false, 'unsupported', 'low'],
    [true, 'supported', 'low'],
  ]);
});
it('retains verified native display order and run identity without misusing transcriptPosition objects', async () => {
  const gateway = fixture();
  transport.responses['chat.history'] = {
    sessionInfo: { model: 'model', modelProvider: 'test' },
    messages: [
      {
        role: 'assistant',
        runId: 'native-run',
        content: 'Later',
        timestamp: 2,
        __openclaw: {
          id: 'assistant-id',
          seq: 2,
          transcriptPosition: { source: 'other-source', rawSeq: 1000 },
        },
      },
      {
        role: 'user',
        runId: 'native-run',
        content: 'Earlier',
        timestamp: 1,
        __openclaw: {
          id: 'user-id',
          seq: 1,
          transcriptPosition: { source: 'main', rawSeq: 9999 },
        },
      },
    ],
    hasMore: true,
    nextOffset: 50,
  };
  const history = await gateway.history({
    agentId: 'agent',
    sessionKey: 'agent:agent:main',
  });
  expect(history.messages).toMatchObject([
    { id: 'assistant-id', runId: 'native-run', historySequence: 2 },
    { id: 'user-id', runId: 'native-run', historySequence: 1 },
  ]);
  expect(history.historyCursor).toBe('older:50');
});
it('forwards genuine successive native deltas before terminal and preserves append/replacement semantics', () => {
  const gateway = fixture();
  const events: GatewayEvent[] = [];
  gateway.onEvent((event) => events.push(event));
  const emit = (payload: unknown) =>
    transport.options?.onEvent?.({ type: 'event', event: 'chat', payload });
  const base = {
    sessionKey: 'agent:agent:main',
    runId: 'native-run',
    state: 'delta',
  };
  emit({
    ...base,
    seq: 1,
    deltaText: 'A',
    message: { role: 'assistant', content: 'A' },
  });
  emit({
    ...base,
    seq: 2,
    deltaText: 'B',
    message: { role: 'assistant', content: 'AB' },
  });
  emit({
    ...base,
    seq: 3,
    message: { role: 'assistant', content: 'Replaced' },
  });
  emit({
    ...base,
    seq: 4,
    state: 'final',
    message: { role: 'assistant', content: 'Replaced' },
  });
  expect(events).toMatchObject([
    { state: 'delta', text: 'A', replace: false },
    { state: 'delta', text: 'B', replace: false },
    { state: 'delta', text: 'Replaced', replace: true },
    { state: 'final', text: 'Replaced' },
  ]);
});
