import { expect, it, vi } from 'vitest';
import { HistoryOperations } from '../src/gateway/history-operations.js';
import { completeMessages } from '../src/gateway/complete-messages.js';
import type { GatewayContext } from '../src/gateway/context.js';
const mapping = { agentId: 'private-agent', sessionKey: 'private-session' };
function context(totalMessages: number) {
  const request = vi
    .fn()
    .mockImplementation((_method: string, params: { limit: number }) =>
      Promise.resolve(
        params.limit === 1
          ? { messages: [], totalMessages }
          : { messages: [], hasMore: true, nextOffset: 100, totalMessages },
      ),
    );
  const value = {
    request,
    capabilityGeneration: 1,
    knownSettings: new Map([
      [
        mapping.sessionKey,
        { model: 'p/m', thinkingLevel: 'off', fastMode: false },
      ],
    ]),
    instructions: { read: () => Promise.resolve({}) },
  } as unknown as GatewayContext;
  return { value, request };
}
it.each([100, 107])(
  'resolves stable native raw-record anchor against current total %i',
  async (total) => {
    const ctx = context(total);
    await new HistoryOperations(ctx.value).history(mapping, {
      cursor: 'before:80',
    });
    expect(ctx.request).toHaveBeenNthCalledWith(
      1,
      'chat.history',
      expect.objectContaining({ limit: 1 }),
    );
    expect(ctx.request).toHaveBeenNthCalledWith(
      2,
      'chat.history',
      expect.objectContaining({ offset: total - 80 + 1 }),
    );
  },
);
it('refuses a reset transcript instead of silently skipping native records', async () => {
  const ctx = context(4);
  await expect(
    new HistoryOperations(ctx.value).history(mapping, { cursor: 'before:80' }),
  ).rejects.toThrow('history changed');
  expect(ctx.request).toHaveBeenCalledTimes(1);
});
it('preserves the pagination record sequence when a large full-message fallback omits it', async () => {
  const original = {
    role: 'assistant',
    content: 'truncated',
    __openclaw: { id: 'message', seq: 81, truncated: true },
  };
  const value = {
    request: vi.fn().mockResolvedValue({ ok: false }),
    fullMessage: vi.fn().mockResolvedValue({
      role: 'assistant',
      content: 'x'.repeat(2530000),
      __openclaw: { id: 'message' },
    }),
  } as unknown as GatewayContext;
  const [result] = await completeMessages(value, mapping, [original]);
  expect(result).toEqual({
    role: 'assistant',
    content: 'x'.repeat(2530000),
    __openclaw: { id: 'message', seq: 81, truncated: false },
  });
});

it('rejects a transcript that changes between anchor resolution and page admission', async () => {
  const ctx = context(100);
  ctx.request.mockImplementation((_method: string, params: { limit: number }) =>
    Promise.resolve(
      params.limit === 1
        ? { messages: [], totalMessages: 100 }
        : { messages: [], totalMessages: 101 },
    ),
  );
  await expect(
    new HistoryOperations(ctx.value).history(mapping, { cursor: 'before:80' }),
  ).rejects.toThrow('changed while loading');
});
