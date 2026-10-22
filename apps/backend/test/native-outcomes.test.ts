import { expect, it, vi } from 'vitest';
import { completedInputs } from '../src/gateway/journal-inputs.js';
import { historySchema } from '../src/gateway/protocol-schemas.js';
import type { GatewayContext } from '../src/gateway/context.js';
const mapping = { agentId: 'agent', sessionKey: 'agent:agent:main' };
const user = (rest: object = {}) => ({
  role: 'user',
  content: 'Same input text',
  __openclaw: {
    id: 'user-event',
    seq: 10,
    idempotencyKey: 'input:user',
    ...rest,
  },
});
const assistant = (rest: object = {}, metadata: object = {}) => ({
  role: 'assistant',
  content: 'Canonical result',
  stopReason: 'stop',
  ...rest,
  __openclaw: { id: 'assistant-event', seq: 20, runId: 'input', ...metadata },
});
async function proof(
  messages: unknown[],
  rest: object = {},
  requested = ['input'],
) {
  const context = {
    capabilityGeneration: 1,
    transport: { ready: true, stopped: false },
    request: vi.fn(),
  } as unknown as GatewayContext;
  const page = historySchema.parse({
    ...mapping,
    sessionId: 'session',
    messages,
    inputReceipts: [],
    hasMore: false,
    ...rest,
  });
  return completedInputs(context, mapping, page, requested, 1);
}

it.each([false, true])(
  'retains native ingested input without output (consumed receipt: %s)',
  async (consumed) => {
    const result = await proof(
      [user()],
      consumed
        ? {
            inputReceipts: [
              {
                runId: 'input',
                state: 'consumed',
                consumedByEventId: 'user-event',
              },
            ],
          }
        : {},
    );
    expect(result.inputs).toEqual([]);
    expect(result.receipts).toEqual([]);
  },
);

it.each([
  { stopReason: 'toolUse' },
  { stopReason: 'error' },
  { stopReason: 'aborted' },
  { stopReason: 'restart' },
  { channel: 'commentary' },
  { channel: 'analysis' },
  { errorMessage: 'Provider failure' },
  { isError: true },
  { requestFailed: true },
  { content: [{ type: 'toolCall', name: 'read' }] },
])(
  'does not mark provisional, interrupted or failed output complete: %j',
  async (change) => {
    expect((await proof([user(), assistant(change)])).inputs).toEqual([]);
  },
);

it('requires a later stable exact-owner final assistant for a steered input', async () => {
  const input = user({ steerTargetRunId: 'parent' });
  const before = assistant({}, { runId: 'parent', seq: 9 });
  const wrongOwner = assistant();
  expect((await proof([before, input, wrongOwner])).inputs).toEqual([]);
  const after = assistant({}, { runId: 'parent', seq: 11 });
  expect((await proof([before, input, after])).inputs).toEqual(['input']);
});

it('fences an input while its resolved steering owner is still active', async () => {
  const result = await proof(
    [user({ steerTargetRunId: 'parent' }), assistant({}, { runId: 'parent' })],
    { inFlightRun: { runId: 'parent' } },
  );
  expect(result.inputs).toEqual([]);
  expect(result.receipts).toEqual([{ runId: 'input', state: 'pending' }]);
});

it('retains canonical steering ownership without duplicating authoritative pending evidence', async () => {
  const result = await proof([user({ steerTargetRunId: 'parent' })], {
    inFlightRun: { runId: 'parent' },
    inputReceipts: [{ runId: 'input', state: 'pending' }],
  });
  expect(result.inputs).toEqual([]);
  expect(result.owners).toEqual([{ inputId: 'input', runId: 'parent' }]);
  expect(result.receipts).toEqual([{ runId: 'input', state: 'pending' }]);
});

it('links collected native input consumption to the exact canonical user event and owner', async () => {
  const receipt = {
    runId: 'collected',
    state: 'consumed',
    consumedByEventId: 'user-event',
  };
  const messages = [
    user({ steerTargetRunId: 'parent' }),
    assistant({}, { runId: 'parent' }),
  ];
  expect(
    (await proof(messages, { inputReceipts: [receipt] }, ['collected'])).inputs,
  ).toEqual(['collected']);
  expect(
    (
      await proof(
        messages,
        { inputReceipts: [{ ...receipt, consumedByEventId: 'foreign-event' }] },
        ['collected'],
      )
    ).inputs,
  ).toEqual([]);
});

it('never overrides explicit pending authority even if canonical output exists', async () => {
  const result = await proof([user(), assistant()], {
    inputReceipts: [{ runId: 'input', state: 'pending' }],
  });
  expect(result.inputs).toEqual([]);
  expect(result.receipts).toEqual([{ runId: 'input', state: 'pending' }]);
});

it('keeps native cancellation separate from completed or ordinary consumed receipts', async () => {
  const result = await proof([user()], {
    inputReceipts: [{ runId: 'input', state: 'pending', cancelled: true }],
  });
  expect(result).toEqual({
    inputs: [],
    cancelled: ['input'],
    receipts: [],
    owners: [{ inputId: 'input', runId: 'input' }],
  });
  expect(
    (await proof([user(), assistant({ stopReason: 'aborted' })])).cancelled,
  ).toEqual(['input']);
});

it('rejects ambiguous canonical input bindings and unstable assistant evidence', async () => {
  await expect(
    proof([user(), user({ id: 'other-event', seq: 11 }), assistant()]),
  ).rejects.toThrow();
  expect(
    (await proof([user(), assistant({}, { id: '', seq: undefined })])).inputs,
  ).toEqual([]);
});

it('settles a late native fallback only from its explicit generated processing owner and later final', async () => {
  const source = user({
    messengerProcessing: { runId: 'generated-owner', keys: ['input:user'] },
  });
  expect(
    (await proof([source, assistant({}, { runId: 'parent' })])).inputs,
  ).toEqual([]);
  expect(
    (await proof([source, assistant({}, { runId: 'generated-owner' })])).inputs,
  ).toEqual(['input']);
});

it('uses exact grouped source association over older base-key fallback for every admitted key', async () => {
  const aggregate = user({
    id: 'aggregate',
    seq: 15,
    idempotencyKey: 'followup-collect:native',
    messengerProcessing: {
      runId: 'aggregate-owner',
      keys: ['input:user', 'second:user'],
    },
  });
  const result = await proof(
    [user(), aggregate, assistant({}, { runId: 'aggregate-owner' })],
    {},
    ['input', 'second'],
  );
  expect(result.inputs).toEqual(['input', 'second']);
  expect(result.owners).toEqual([
    { inputId: 'input', runId: 'aggregate-owner' },
    { inputId: 'second', runId: 'aggregate-owner' },
  ]);
});

it.each([false, true])(
  'chooses the newest explicit retry association independent of page order (%s)',
  async (reverse) => {
    const older = user({
      messengerProcessing: { runId: 'old-owner', keys: ['input:user'] },
    });
    const newer = user({
      id: 'retry-aggregate',
      seq: 30,
      idempotencyKey: 'followup-overflow:native',
      messengerProcessing: { runId: 'new-owner', keys: ['input:user'] },
    });
    const sources = reverse ? [newer, older] : [older, newer];
    expect(
      (
        await proof([
          ...sources,
          assistant({}, { runId: 'old-owner', seq: 20 }),
        ])
      ).inputs,
    ).toEqual([]);
    expect(
      (
        await proof([
          ...sources,
          assistant({}, { runId: 'new-owner', seq: 40 }),
        ])
      ).inputs,
    ).toEqual(['input']);
  },
);

it('rejects contradictory confirmed steer and equal-sequence explicit owner proofs', async () => {
  await expect(
    proof([
      user({
        steerTargetRunId: 'parent',
        messengerProcessing: { runId: 'other', keys: ['input:user'] },
      }),
    ]),
  ).rejects.toThrow();
  await expect(
    proof([
      user({ messengerProcessing: { runId: 'first', keys: ['input:user'] } }),
      user({
        id: 'conflicting',
        messengerProcessing: { runId: 'second', keys: ['input:user'] },
      }),
    ]),
  ).rejects.toThrow();
});

it.each([
  { runId: ' generated ', keys: ['input:user'] },
  { runId: 'generated', keys: [' input:user '] },
])(
  'never normalizes malformed native owner/key proof into an input identity: %j',
  async (messengerProcessing) => {
    expect(
      (
        await proof([
          user({ messengerProcessing }),
          assistant({}, { runId: 'generated' }),
        ])
      ).inputs,
    ).toEqual([]);
  },
);
