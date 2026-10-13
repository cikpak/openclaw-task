import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.js';
import { messageSchema, snapshotSchema } from '../src/schemas.js';

const wire = vi.hoisted(() => ({ messages: [] as unknown[] }));
vi.mock('@openclaw/gateway-client', () => ({
  GatewayClient: class {
    start() {}
    async stopAndWait() {}
    async request(method: string, params: Record<string, unknown>) {
      await Promise.resolve();
      if (method === 'agents.files.get')
        return {
          agentId: params.agentId,
          file: { name: 'AGENTS.md', missing: true },
        };
      if (method === 'chat.history')
        return {
          messages: wire.messages,
          sessionInfo: {
            model: 'model',
            modelProvider: 'test',
            thinkingLevel: 'off',
            fastMode: false,
          },
        };
      throw new Error(`Unexpected RPC: ${method}`);
    }
  },
}));
import { OpenClawGateway } from '../src/gateway/openclaw.js';

const adapters: OpenClawGateway[] = [];
function gateway() {
  const adapter = new OpenClawGateway(
    parseConfig({
      APP_USERNAME: 'owner',
      APP_PASSWORD_HASH: `scrypt$${'a'.repeat(32)}$${'b'.repeat(64)}`,
      SESSION_KEY: 'a'.repeat(64),
      GATEWAY_TOKEN: 'x'.repeat(32),
      GATEWAY_TLS_FINGERPRINT: 'AA'.repeat(32),
      APP_ORIGIN: 'http://localhost:5173',
      ALLOW_INSECURE_LOOPBACK: 'true',
      DATA_DIR: mkdtempSync(join(tmpdir(), 'messenger-request-status-')),
    }),
  );
  adapter.start();
  adapter.ready = true;
  adapters.push(adapter);
  return adapter;
}
const scope = { agentId: 'messenger-a', sessionKey: 'agent:messenger-a:main' };
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stop()));
  wire.messages = [];
});

it('preserves explicit native assistant failures before any streaming text exists', async () => {
  wire.messages = [
    {
      id: 'failed',
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Provider rejected this request.',
      timestamp: 3,
    },
  ];
  const first = (await gateway().history(scope)).messages[0];
  expect(first).toMatchObject({ id: 'failed', text: '', requestFailed: true });
  expect(messageSchema.parse(first).requestFailed).toBe(true);
  const refreshed = (await gateway().history(scope)).messages[0];
  expect(refreshed?.requestFailed).toBe(true);
});

it('does not infer request failure from ordinary answer text or a failed tool', async () => {
  wire.messages = [
    {
      id: 'success',
      role: 'assistant',
      content: 'A request failed in this example.',
      stopReason: 'stop',
      timestamp: 2,
    },
    {
      id: 'tool',
      role: 'toolResult',
      content: 'Failed read',
      stopReason: 'error',
      timestamp: 3,
    },
  ];
  const messages = (await gateway().history(scope)).messages;
  expect(messages).toHaveLength(2);
  expect(messages.every((message) => message.requestFailed === undefined)).toBe(
    true,
  );
});

it('transports the failure marker through cached snapshot validation without affecting legacy messages', () => {
  const message = {
    id: 'failed',
    role: 'assistant' as const,
    text: '',
    createdAt: 2,
    requestFailed: true,
  };
  const snapshot = snapshotSchema.parse({
    chat: {
      id: 'chat',
      name: 'Chat',
      status: 'idle',
      version: 1,
      createdAt: 1,
      updatedAt: 2,
      unread: true,
      settings: { model: 'test/model', thinkingLevel: 'off', fastMode: false },
    },
    messages: [message],
    pending: [],
    activeRun: null,
    pendingSettings: null,
    hasOlderHistory: false,
    historyCursor: null,
  });
  expect(snapshot.messages[0]?.requestFailed).toBe(true);
  expect(
    messageSchema.parse({ ...message, requestFailed: undefined }),
  ).not.toHaveProperty('requestFailed', true);
  expect(() =>
    messageSchema.parse({ ...message, requestFailed: 'yes' }),
  ).toThrow();
});
