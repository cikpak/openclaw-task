import { expect, it, vi } from 'vitest';
import { SendOperations } from '../src/gateway/send-operations.js';
import type { GatewayContext } from '../src/gateway/context.js';
const mapping = { agentId: 'agent', sessionKey: 'agent:agent:main' };
const input = {
  kind: 'pre-execution-input-cancelled',
  inputId: 'input',
  sessionId: 'native-session',
  ...mapping,
};
const response = () => ({
  ok: true,
  aborted: true,
  runIds: ['input'],
  preExecutionInputCancellations: [{ ...input }],
});
const api = (value: unknown) => {
  const request = vi.fn().mockResolvedValue(value);
  return {
    api: new SendOperations({ request } as unknown as GatewayContext),
    request,
  };
};
it('parses source-typed scoped input proof independently of ordinary cancellation IDs', async () => {
  const f = api(response());
  expect(await f.api.abortChat(mapping)).toEqual({
    runIds: ['input'],
    inputs: [input],
  });
  expect(f.request).toHaveBeenCalledExactlyOnceWith('chat.abort', mapping);
});
it('ordinary authenticated rich IDs never acquire absent-USER input authority', async () => {
  expect(
    await api({ ok: true, aborted: true, runIds: ['input'] }).api.abortChat(
      mapping,
    ),
  ).toEqual({ runIds: ['input'], inputs: [] });
});
it.each([
  { warning: 'partial' },
  { warning: '' },
  { warning: undefined },
  { warning: false },
  { ok: false },
  { aborted: false },
  { runIds: [] },
  { runIds: ['input', 'input'] },
  { runIds: [' input '] },
  { runIds: [''] },
  { runIds: ['other'] },
  { preExecutionInputCancellations: [input, input] },
  { preExecutionInputCancellations: [{ ...input, kind: 'cancelled' }] },
  { preExecutionInputCancellations: [{ ...input, inputId: ' input ' }] },
  { preExecutionInputCancellations: [{ ...input, sessionId: '' }] },
  {
    preExecutionInputCancellations: [
      { ...input, sessionId: ' native-session ' },
    ],
  },
  { preExecutionInputCancellations: [{ ...input, agentId: 'other' }] },
  { preExecutionInputCancellations: [{ ...input, sessionKey: 'other' }] },
  { preExecutionInputCancellations: [{}] },
])(
  'rejects partial, contradictory or malformed native proof %j',
  async (patch) => {
    expect(
      await api({ ...response(), ...patch }).api.abortChat(mapping),
    ).toBeUndefined();
  },
);
it('propagates lost native acknowledgement without manufacturing proof', async () => {
  const request = vi.fn().mockRejectedValue(Error('Lost ACK'));
  await expect(
    new SendOperations({ request } as unknown as GatewayContext).abortChat(
      mapping,
    ),
  ).rejects.toThrow('Lost ACK');
});
