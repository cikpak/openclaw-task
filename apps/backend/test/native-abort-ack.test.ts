import { expect, it, vi } from 'vitest';
import { SendOperations } from '../src/gateway/send-operations.js';
import type { GatewayContext } from '../src/gateway/context.js';
const mapping = { agentId: 'agent', sessionKey: 'agent:agent:main' };

it.each([
  { ok: true, status: 'aborted', abortedRunId: 'owner' },
  { ok: true, status: 'no-active-run', abortedRunId: null },
  { ok: true, status: 'aborted', abortedRunId: null },
  {
    ok: true,
    status: 'aborted',
    abortedRunId: 'owner',
    warning: 'Partial result',
  },
  { ok: true },
  {},
])(
  'requires an exact persisted native abort acknowledgement: %j',
  async (response) => {
    const request = vi.fn().mockResolvedValue(response);
    const api = new SendOperations({ request } as unknown as GatewayContext);
    const proof = await api.abort(mapping);
    expect(proof).toEqual(
      'abortedRunId' in response &&
        response.abortedRunId === 'owner' &&
        !('warning' in response)
        ? { abortedRunId: 'owner' }
        : undefined,
    );
    expect(request).toHaveBeenCalledExactlyOnceWith('sessions.abort', {
      key: mapping.sessionKey,
      agentId: mapping.agentId,
      clearQueued: true,
    });
  },
);

it('does not turn a lost ACK into a cancellation proof', async () => {
  const api = new SendOperations({
    request: vi.fn().mockRejectedValue(new Error('Connection lost')),
  } as unknown as GatewayContext);
  await expect(api.abort(mapping)).rejects.toThrow('Connection lost');
});
