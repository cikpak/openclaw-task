import { expect, it, vi } from 'vitest';
import { SendOperations } from '../src/gateway/send-operations.js';
import type { GatewayContext } from '../src/gateway/context.js';
const mapping = { agentId: 'agent', sessionKey: 'agent:agent:main' };
it.each([
  [{ ok: true, status: 'aborted', abortedRunId: 'generated' }, true],
  [{ ok: true, status: 'aborted', abortedRunId: 'input' }, false],
  [{ ok: true, status: 'aborted', abortedRunId: ' generated ' }, false],
  [{ ok: true, status: 'no-active-run', abortedRunId: 'generated' }, false],
  [{ ok: true, status: 'aborted', abortedRunId: null }, false],
  [
    {
      ok: true,
      status: 'aborted',
      abortedRunId: 'generated',
      warning: 'partial',
    },
    false,
  ],
  [{ ok: true }, false],
])(
  'accepts only the selected persisted execution ACK: %j',
  async (response, valid) => {
    const request = vi.fn().mockResolvedValue(response);
    const api = new SendOperations({ request } as unknown as GatewayContext);
    expect(await api.abort(mapping, 'generated')).toEqual(
      valid ? { abortedRunId: 'generated' } : undefined,
    );
    expect(request).toHaveBeenCalledExactlyOnceWith('sessions.abort', {
      key: mapping.sessionKey,
      agentId: mapping.agentId,
      runId: 'generated',
    });
  },
);
it('preserves lost exact ACK uncertainty', async () => {
  const api = new SendOperations({
    request: vi.fn().mockRejectedValue(Error('lost')),
  } as unknown as GatewayContext);
  await expect(api.abort(mapping, 'generated')).rejects.toThrow('lost');
});

it.each(['', ' generated', 'generated '])(
  'rejects malformed exact selectors without a broad side effect: %j',
  async (owner) => {
    const request = vi.fn();
    const api = new SendOperations({ request } as unknown as GatewayContext);
    await expect(api.abort(mapping, owner)).rejects.toThrow(
      'Invalid native cancellation owner',
    );
    expect(request).not.toHaveBeenCalled();
  },
);
