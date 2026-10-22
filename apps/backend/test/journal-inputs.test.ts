import { expect, it, vi } from 'vitest';
import { completedInputs as collectEvidence } from '../src/gateway/journal-inputs.js';
import { historySchema } from '../src/gateway/protocol-schemas.js';
import { projectMessage } from '../src/gateway/messages.js';
import type { GatewayContext } from '../src/gateway/context.js';

async function completedInputs(...args: Parameters<typeof collectEvidence>) {
  return (await collectEvidence(...args)).inputs;
}
const mapping = { agentId: 'agent-a', sessionKey: 'agent:agent-a:main' };
const canonical = (id = 'input') => ({
  role: 'user',
  content: 'Identical text',
  __openclaw: {
    id: 'stable-native-event',
    seq: 1,
    idempotencyKey: `${id}:user`,
  },
});
const reply = () => ({
  role: 'assistant',
  content: 'Final output',
  stopReason: 'stop',
  __openclaw: { id: 'assistant-event', seq: 2, runId: 'input' },
});
const page = (messages: unknown[] = [], rest: object = {}) =>
  historySchema.parse({
    sessionId: 'native-session',
    sessionKey: mapping.sessionKey,
    messages,
    hasMore: false,
    inputReceipts: [],
    ...rest,
  });
function fixture() {
  const request = vi.fn();
  const context = {
    capabilityGeneration: 1,
    transport: { ready: true, stopped: false },
    request,
  } as unknown as GatewayContext;
  return { context, request };
}

it('uses only exact requested canonical user identity, never matching text or assistant identity', async () => {
  const f = fixture();
  const messages = [
    canonical('other'),
    { ...canonical(), role: 'assistant' },
    { role: 'user', content: 'Identical text', idempotencyKey: 'input' },
    {
      ...canonical(),
      __openclaw: { id: 'event', idempotencyKey: 'input:wrong' },
    },
    canonical(),
    reply(),
  ];
  expect(
    await completedInputs(f.context, mapping, page(messages), ['input'], 1),
  ).toEqual(['input']);
  expect(f.request).not.toHaveBeenCalled();
  expect(projectMessage(canonical(), 0)).not.toHaveProperty('idempotencyKey');
  expect(projectMessage(canonical(), 0)).not.toHaveProperty('__openclaw');
  expect(JSON.stringify(projectMessage(canonical(), 0))).not.toContain(
    'input:user',
  );
});

it.each([undefined, false, true])(
  'explicit native receipt outranks fallback (cancelled: %s)',
  async (cancelled) => {
    const f = fixture();
    expect(
      await completedInputs(
        f.context,
        mapping,
        page([canonical()], {
          inputReceipts: [
            {
              runId: 'input',
              state: 'pending',
              ...(cancelled === undefined ? {} : { cancelled }),
            },
          ],
        }),
        ['input'],
        1,
      ),
    ).toEqual([]);
  },
);

it('searches every bounded native page beyond fifty without changing public history', async () => {
  const f = fixture();
  f.request.mockImplementation((_method: string, params: { offset: number }) =>
    Promise.resolve(
      page(params.offset === 60 ? [canonical()] : [canonical('other')], {
        hasMore: params.offset < 60,
        nextOffset: params.offset + 1,
        totalMessages: 61,
      }),
    ),
  );
  expect(
    await completedInputs(
      f.context,
      mapping,
      page([reply()], {
        hasMore: true,
        nextOffset: 1,
        totalMessages: 61,
      }),
      ['input'],
      1,
    ),
  ).toEqual(['input']);
  expect(f.request).toHaveBeenCalledTimes(60);
  expect(f.request).toHaveBeenLastCalledWith(
    'chat.history',
    expect.objectContaining({
      ...mapping,
      offset: 60,
      inputRunIds: ['input'],
    }),
  );
});

it.each([
  { sessionId: 'reset-session' },
  { sessionKey: 'agent:other:main' },
  { sessionInfo: { sessionId: 'reset-session' } },
  { totalMessages: 3 },
  { hasMore: true, nextOffset: 1 },
])(
  'fails closed on reset, foreign scope or nonprogressing pagination: %j',
  async (change) => {
    const f = fixture();
    f.request.mockResolvedValue(page([], { totalMessages: 2, ...change }));
    await expect(
      completedInputs(
        f.context,
        mapping,
        page([], {
          hasMore: true,
          nextOffset: 1,
          totalMessages: 2,
        }),
        ['input'],
        1,
      ),
    ).rejects.toThrow();
  },
);

it('cancels proof collection when the native connection generation changes', async () => {
  const f = fixture();
  f.request.mockImplementation(() => {
    f.context.capabilityGeneration++;
    return Promise.resolve(page([canonical()]));
  });
  await expect(
    completedInputs(
      f.context,
      mapping,
      page([], {
        hasMore: true,
        nextOffset: 1,
      }),
      ['input'],
      1,
    ),
  ).rejects.toThrow();
});

it('rejects synthetic native pending-input IDs even if a key is present', async () => {
  const f = fixture();
  const value = canonical();
  value.__openclaw.id = 'pending:synthetic';
  expect(
    await completedInputs(f.context, mapping, page([value]), ['input'], 1),
  ).toEqual([]);
});

it('retains explicit pending receipt authority discovered on a later page', async () => {
  const f = fixture();
  f.request.mockResolvedValue(
    page([canonical()], {
      inputReceipts: [{ runId: 'input', state: 'pending' }],
    }),
  );
  const evidence = await collectEvidence(
    f.context,
    mapping,
    page([], {
      hasMore: true,
      nextOffset: 1,
    }),
    ['input'],
    1,
  );
  expect(evidence.inputs).toEqual([]);
  expect(evidence.receipts).toEqual([{ runId: 'input', state: 'pending' }]);
});
