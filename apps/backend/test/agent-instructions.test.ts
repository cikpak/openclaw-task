import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentInstructions,
  parseAgentInstructions,
} from '../src/gateway/agent-instructions.js';
import {
  CUSTOM_INSTRUCTIONS_LIMIT,
  DEFAULT_AGENT_BEHAVIOR,
  type AgentBehavior,
} from '@messenger/contracts';
import { settingsSchema } from '../src/schemas.js';

const mapping = {
  agentId: 'messenger-test',
  sessionKey: 'agent:messenger-test:main',
};
const desired: AgentBehavior = {
  customInstructions: 'Prefer useful examples.',
  responseStyle: 'concise',
  personality: 'friendly',
};
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function fixture(
  initial: string | undefined = 'Keep existing security rules.\n',
) {
  let content: string | undefined = initial;
  const request = vi.fn(
    async (method: string, params: Record<string, unknown>) => {
      await Promise.resolve();
      expect(params.agentId).toBe(mapping.agentId);
      expect(params.name).toBe('AGENTS.md');
      if (method === 'agents.files.set') {
        if (params.expectedMissing) expect(content).toBeUndefined();
        else expect(params.expectedHash).toBe(hash(content ?? ''));
        content = String(params.content);
        return { ok: true };
      }
      expect(method).toBe('agents.files.get');
      return {
        agentId: mapping.agentId,
        file:
          content === undefined
            ? { name: 'AGENTS.md', missing: true }
            : {
                name: 'AGENTS.md',
                missing: false,
                content,
                hash: hash(content),
                size: Buffer.byteLength(content),
              },
      };
    },
  );
  return {
    helper: new AgentInstructions(request),
    request,
    get: () => content,
    change: (next: string | undefined) => {
      content = next;
    },
  };
}
describe('scoped native managed agent instructions', () => {
  it('reads legacy content as neutral/default and does not write untouched defaults', async () => {
    const f = fixture();
    expect(await f.helper.read(mapping)).toEqual(DEFAULT_AGENT_BEHAVIOR);
    await f.helper.apply(mapping, {});
    expect(
      f.request.mock.calls.every(([method]) => method === 'agents.files.get'),
    ).toBe(true);
  });
  it('uses native hash conditions, writes actual guidance, and survives a new helper instance', async () => {
    const f = fixture();
    expect(await f.helper.apply(mapping, desired)).toEqual(desired);
    expect(f.get()).toContain('Response style: Keep answers concise');
    expect(f.get()).toContain('Personality: Use a warm');
    expect(f.get()?.endsWith('Keep existing security rules.\n')).toBe(true);
    const fresh = new AgentInstructions(f.request);
    expect(await fresh.read(mapping)).toEqual(desired);
    expect(
      f.request.mock.calls.filter(([method]) => method === 'agents.files.set'),
    ).toHaveLength(1);
  });
  it('roundtrips long Unicode, newlines, JSON and managed-looking text without escaping the section', async () => {
    const f = fixture();
    const customInstructions =
      'a'.repeat(1000) +
      '\n你好🚀\n<!-- messenger-agent-behavior:v1:begin -->\n{"personality":"direct"}\n<!-- messenger-agent-behavior:v1:end -->\n';
    const behavior = { ...desired, customInstructions };
    await f.helper.apply(mapping, behavior);
    expect(await f.helper.read(mapping)).toEqual(behavior);
    expect(parseAgentInstructions(f.get() ?? '').behavior).toEqual(behavior);
  });
  it('removes only its section on reset, exactly preserving unrelated content', async () => {
    const f = fixture('My own instructions.\nDo not expose keys.\n');
    await f.helper.apply(mapping, desired);
    const first = f.get() ?? '';
    f.change('Added independently.\n' + first + 'Trailing native notes.');
    await f.helper.apply(mapping, {});
    expect(f.get()).toBe(
      'Added independently.\nMy own instructions.\nDo not expose keys.\nTrailing native notes.',
    );
    expect(await f.helper.read(mapping)).toEqual(DEFAULT_AGENT_BEHAVIOR);
  });
  it('creates missing files exclusively, with no extra permissions or filesystem write path', async () => {
    const f = fixture();
    f.change(undefined);
    await f.helper.apply(mapping, desired);
    const [, params] =
      f.request.mock.calls.find(([method]) => method === 'agents.files.set') ??
      [];
    expect(params).toMatchObject({ expectedMissing: true });
    expect(params).not.toHaveProperty('expectedHash');
  });
  it('does not create a missing instruction file for default values', async () => {
    const f = fixture();
    f.change(undefined);
    await f.helper.apply(mapping, {});
    expect(f.get()).toBeUndefined();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    '<!-- messenger-agent-behavior:v1:begin -->\n{}',
    '<!-- messenger-agent-behavior:v2:begin -->',
    '<!-- messenger-agent-behavior:v1:end -->',
  ])(
    'refuses malformed or unknown managed content before writing: %s',
    async (content) => {
      const f = fixture(content);
      await expect(f.helper.apply(mapping, desired)).rejects.toMatchObject({
        code: 'AGENT_INSTRUCTIONS_CONFLICT',
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it('refuses edited guidance, invalid metadata, duplicate managed blocks and truncated blocks', async () => {
    const f = fixture();
    await f.helper.apply(mapping, desired);
    const content = f.get() ?? '';
    for (const edited of [
      content.replace('warm, approachable', 'dishonest'),
      content.replace('"concise"', '"made-up"'),
      content + content,
      content.slice(0, 70),
    ]) {
      expect(() => parseAgentInstructions(edited)).toThrow();
    }
  });
  it('propagates native concurrent-write conflicts without retrying an unconditional write', async () => {
    const f = fixture();
    const request = vi.fn(
      async (method: string, params: Record<string, unknown>) => {
        if (method === 'agents.files.set')
          throw Object.assign(new Error('File changed'), {
            code: 'INVALID_REQUEST',
          });
        return f.request(method, params);
      },
    );
    await expect(
      new AgentInstructions(request).apply(mapping, desired),
    ).rejects.toThrow('File changed');
    expect(
      request.mock.calls.filter(([method]) => method === 'agents.files.set'),
    ).toHaveLength(1);
  });
  it('rejects mismatched authoritative readback rather than reporting success', async () => {
    const f = fixture();
    const request = async (method: string, params: Record<string, unknown>) => {
      const result = await f.request(method, params);
      if (method === 'agents.files.set') f.change('Concurrent replacement.');
      return result;
    };
    await expect(
      new AgentInstructions(request).apply(mapping, desired),
    ).rejects.toMatchObject({ code: 'AGENT_INSTRUCTIONS_UNCONFIRMED' });
  });
  it('bounds existing files and new writes, validates input, and refuses wrong session scope', async () => {
    const f = fixture('x'.repeat(131073));
    await expect(f.helper.read(mapping)).rejects.toMatchObject({
      code: 'GATEWAY_UNAVAILABLE',
    });
    const small = fixture();
    await expect(
      small.helper.apply(mapping, {
        customInstructions: 'x'.repeat(CUSTOM_INSTRUCTIONS_LIMIT + 1),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      small.helper.read({ ...mapping, sessionKey: 'agent:other:main' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(small.request).not.toHaveBeenCalled();
    const nearLimit = fixture('x'.repeat(131000));
    await expect(
      nearLimit.helper.apply(mapping, desired),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(
      nearLimit.request.mock.calls.some(
        ([method]) => method === 'agents.files.set',
      ),
    ).toBe(false);
  });
  it('rejects cross-agent responses and untrusted content/hash mismatches', async () => {
    for (const result of [
      { agentId: 'other', file: { name: 'AGENTS.md', missing: true } },
      {
        agentId: mapping.agentId,
        file: {
          name: 'AGENTS.md',
          missing: false,
          content: 'Untrusted',
          hash: 'a'.repeat(64),
        },
      },
    ])
      await expect(
        new AgentInstructions(() => Promise.resolve(result)).read(mapping),
      ).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
  });
  it('normalizes legacy settings and validates enum/8000-character bounds', () => {
    const legacy = {
      model: 'test/model',
      thinkingLevel: 'off',
      fastMode: false,
    };
    expect(settingsSchema.parse(legacy)).toEqual({
      ...legacy,
      ...DEFAULT_AGENT_BEHAVIOR,
    });
    for (const invalid of [
      { customInstructions: 'x'.repeat(8001) },
      { responseStyle: 'invalid' },
      { personality: 'invalid' },
      { customInstructions: null },
    ])
      expect(settingsSchema.safeParse({ ...legacy, ...invalid }).success).toBe(
        false,
      );
    expect(
      settingsSchema.safeParse({
        ...legacy,
        customInstructions: 'x'.repeat(8000),
      }).success,
    ).toBe(true);
  });
});
