import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsSchema } from '../src/schemas.js';
import { parseConfig } from '../src/config.js';

const wire = vi.hoisted(() => ({
  files: new Map<string, string>(),
  requests: [] as { method: string; params: Record<string, unknown> }[],
  failWrite: false,
  mutateOnHistory: false,
  settings: {
    model: 'model',
    modelProvider: 'test',
    thinkingLevel: 'off',
    fastMode: false,
  },
}));
vi.mock('@openclaw/gateway-client', () => ({
  GatewayClient: class {
    start() {}
    async stopAndWait() {}
    async request(method: string, params: Record<string, unknown>) {
      await Promise.resolve();
      wire.requests.push({ method, params });
      const id = String(params.agentId);
      if (method === 'agents.files.get') {
        const content = wire.files.get(id);
        return {
          agentId: id,
          file:
            content === undefined
              ? { name: 'AGENTS.md', missing: true }
              : {
                  name: 'AGENTS.md',
                  missing: false,
                  content,
                  hash: createHash('sha256').update(content).digest('hex'),
                },
        };
      }
      if (method === 'agents.files.set') {
        if (wire.failWrite)
          throw new Error('Lost native write acknowledgement');
        wire.files.set(id, String(params.content));
        return { ok: true };
      }
      if (method === 'sessions.patch') {
        wire.settings = {
          model: String(params.model).split('/').at(-1) ?? 'model',
          modelProvider: 'test',
          thinkingLevel: String(params.thinkingLevel),
          fastMode: params.fastMode === true,
        };
        return { ok: true, entry: wire.settings, resolved: wire.settings };
      }
      if (method === 'chat.history') {
        if (wire.mutateOnHistory)
          wire.files.set(id, 'Concurrent native content.');
        return {
          messages: [],
          sessionInfo: wire.settings,
          thinkingLevel: wire.settings.thinkingLevel,
          fastMode: wire.settings.fastMode,
        };
      }
      throw new Error(`Unexpected native RPC: ${method}`);
    }
  },
}));
import { OpenClawGateway } from '../src/gateway/openclaw.js';

const gateways: OpenClawGateway[] = [];
const mapping = {
  agentId: 'messenger-a',
  sessionKey: 'agent:messenger-a:main',
};
const desired = settingsSchema.parse({
  model: 'test/model',
  thinkingLevel: 'off',
  fastMode: false,
  customInstructions: 'Use a short example.',
  responseStyle: 'detailed',
  personality: 'professional',
});
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
      DATA_DIR: mkdtempSync(join(tmpdir(), 'messenger-behavior-')),
    }),
  );
  adapter.start();
  adapter.ready = true;
  gateways.push(adapter);
  return adapter;
}
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((entry) => entry.stop()));
  wire.files.clear();
  wire.requests.length = 0;
  wire.failWrite = false;
  wire.mutateOnHistory = false;
});
describe('behavior native settings/readback integration', () => {
  it('uses only three supported native session settings, stores guidance separately and matches recovery JSON ordering', async () => {
    const adapter = gateway();
    const effective = await adapter.settings(mapping, desired);
    expect(effective).toEqual(desired);
    // ChatService recovery intentionally compares serialized normalized settings.
    expect(JSON.stringify(effective)).toBe(
      JSON.stringify(settingsSchema.parse(desired)),
    );
    const patch = wire.requests.find(
      ({ method }) => method === 'sessions.patch',
    );
    expect(patch?.params).toEqual({
      key: mapping.sessionKey,
      agentId: mapping.agentId,
      model: desired.model,
      thinkingLevel: desired.thinkingLevel,
      fastMode: desired.fastMode,
    });
    expect(wire.files.get(mapping.agentId)).toContain(
      desired.customInstructions,
    );
    expect((await adapter.history(mapping)).settings).toEqual(desired);
    expect((await gateway().history(mapping)).settings).toEqual(desired);
  });
  it('reads legacy native files as defaults without sharing behavior across agents', async () => {
    const adapter = gateway();
    await adapter.settings(mapping, desired);
    const other = {
      agentId: 'messenger-b',
      sessionKey: 'agent:messenger-b:main',
    };
    const effective = (await adapter.history(other)).settings;
    expect(effective.customInstructions).toBe('');
    expect(effective.responseStyle).toBe('default');
    expect(effective.personality).toBe('neutral');
    expect((await adapter.history(mapping)).settings.customInstructions).toBe(
      desired.customInstructions,
    );
  });
  it('throws for partial session/file application instead of returning success', async () => {
    const adapter = gateway();
    wire.failWrite = true;
    await expect(adapter.settings(mapping, desired)).rejects.toThrow(
      'Lost native write acknowledgement',
    );
    expect(
      wire.requests.some(({ method }) => method === 'sessions.patch'),
    ).toBe(true);
    expect(wire.files.has(mapping.agentId)).toBe(false);
  });
  it('rejects a managed behavior change after file confirmation but before history confirmation', async () => {
    const adapter = gateway();
    wire.mutateOnHistory = true;
    await expect(adapter.settings(mapping, desired)).rejects.toMatchObject({
      code: 'AGENT_INSTRUCTIONS_UNCONFIRMED',
    });
  });
});
