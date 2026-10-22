import { describe, expect, it, vi } from 'vitest';
import { GatewayFacade } from '../src/gateway/facade.js';
import { AgentInstructions } from '../src/gateway/agent-instructions.js';
import { DELIVERABLE_INSTRUCTIONS } from '../src/gateway/deliverable-instructions.js';
import { nativeAgentFileRequest } from './native-agent-files.js';

const mapping = {
  agentId: 'messenger-existing',
  sessionKey: 'agent:messenger-existing:main',
};
function fixture(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set(mapping.agentId, initial);
  let beforeWrite: (() => void) | undefined;
  let afterWrite: (() => void) | undefined;
  const request = vi.fn(
    async (method: string, params: Record<string, unknown>) => {
      await Promise.resolve();
      if (method === 'chat.send')
        return { runId: params.idempotencyKey, status: 'started' };
      if (method === 'agents.files.set') beforeWrite?.();
      const result = nativeAgentFileRequest(files, method, params);
      if (method === 'agents.files.set') afterWrite?.();
      return result;
    },
  );
  const gateway = new GatewayFacade(
    {
      ready: true,
      stopped: false,
      maxPayload: 1_000_000,
      start() {},
      stop: () => Promise.resolve(),
      request: (method, params) =>
        request(method, params as Record<string, unknown>),
    },
    {
      list: () => Promise.resolve([]),
      handles: () => false,
      download: () => Promise.reject(new Error('unused')),
      sourcePath: () => {
        throw new Error('unused');
      },
    },
  );
  return {
    files,
    request,
    gateway,
    instructions: new AgentInstructions(request),
    beforeWrite: (callback: () => void) => (beforeWrite = callback),
    afterWrite: (callback: () => void) => (afterWrite = callback),
    send: async () => {
      await gateway.prepareSend(mapping);
      return gateway.send(mapping, 'submission', 'Create a joke file', 'queue');
    },
  };
}
describe('native deliverable instructions before dispatch', () => {
  it('creates guidance for a new agent before sending and leaves the user message intact', async () => {
    const f = fixture();
    expect(await f.send()).toEqual({ runId: 'submission', status: 'started' });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      'agents.files.get',
      'agents.files.set',
      'agents.files.get',
      'chat.send',
    ]);
    expect(f.request.mock.calls[1]?.[1]).toMatchObject({
      expectedMissing: true,
    });
    expect(f.files.get(mapping.agentId)).toBe(DELIVERABLE_INSTRUCTIONS);
    expect(f.request.mock.calls[3]?.[1]).toMatchObject({
      message: 'Create a joke file',
      idempotencyKey: 'submission',
      queueMode: 'followup',
    });
    await f.send();
    expect(
      f.request.mock.calls.filter(([method]) => method === 'agents.files.set'),
    ).toHaveLength(1);
  });
  it('migrates existing agents without changing behavior, unrelated bytes, or sessions', async () => {
    const original = 'Keep existing rules.\n\u4f60\u597d\n';
    const f = fixture(original);
    const behavior = {
      responseStyle: 'concise' as const,
      personality: 'friendly' as const,
      customInstructions: '<!-- messenger-deliverables:v9:begin -->\nMy text.',
    };
    await f.instructions.apply(mapping, behavior);
    const before = f.files.get(mapping.agentId)!;
    f.request.mockClear();
    await f.send();
    expect(f.files.get(mapping.agentId)).toBe(
      DELIVERABLE_INSTRUCTIONS + before,
    );
    expect(await f.instructions.read(mapping)).toEqual(behavior);
    const write = f.request.mock.calls.find(
      ([method]) => method === 'agents.files.set',
    );
    expect(write?.[1]).toHaveProperty('expectedHash');
    expect(write?.[1]).not.toHaveProperty('expectedMissing');
    expect(
      f.request.mock.calls.every(([method]) => !method.startsWith('sessions.')),
    ).toBe(true);
    await f.instructions.apply(mapping, {});
    expect(f.files.get(mapping.agentId)).toBe(
      DELIVERABLE_INSTRUCTIONS + original,
    );
  });
  it('does not dispatch or overwrite a concurrent native edit', async () => {
    const f = fixture('Original rules.');
    f.beforeWrite(() => f.files.set(mapping.agentId, 'Concurrent edit.'));
    await expect(f.send()).rejects.toThrow('changed before write');
    expect(f.files.get(mapping.agentId)).toBe('Concurrent edit.');
    expect(
      f.request.mock.calls.some(([method]) => method === 'chat.send'),
    ).toBe(false);
    expect(
      f.request.mock.calls.filter(([method]) => method === 'agents.files.set'),
    ).toHaveLength(1);
  });
  it('requires authoritative readback before dispatch', async () => {
    const f = fixture();
    f.afterWrite(() => f.files.set(mapping.agentId, 'Changed after ACK.'));
    await expect(f.send()).rejects.toMatchObject({
      code: 'AGENT_INSTRUCTIONS_UNCONFIRMED',
    });
    expect(
      f.request.mock.calls.some(([method]) => method === 'chat.send'),
    ).toBe(false);
  });
  it.each([
    '<!-- messenger-deliverables:v2:begin -->',
    DELIVERABLE_INSTRUCTIONS.replace(
      'Use the native write',
      'Use an invented write',
    ),
    DELIVERABLE_INSTRUCTIONS + DELIVERABLE_INSTRUCTIONS,
  ])(
    'refuses corrupted or unknown managed guidance without dispatching',
    async (content) => {
      const f = fixture(content);
      await expect(f.send()).rejects.toMatchObject({
        code: 'AGENT_DELIVERABLE_INSTRUCTIONS_CONFLICT',
      });
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(f.files.get(mapping.agentId)).toBe(content);
    },
  );
  it('does not mutate instructions for an oversized message', async () => {
    const f = fixture();
    f.gateway.maxPayload = 1;
    await expect(
      f.gateway.send(mapping, 'submission', 'large', 'queue'),
    ).rejects.toMatchObject({ code: 'GATEWAY_PAYLOAD_LIMIT' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('refuses an oversized resulting file and wrong-session scope before any write', async () => {
    const f = fixture('x'.repeat(130000));
    await expect(f.send()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.request).toHaveBeenCalledTimes(1);
    f.request.mockClear();
    await expect(
      f.gateway.prepareSend({ ...mapping, sessionKey: 'agent:other:main' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.request).not.toHaveBeenCalled();
  });
});
