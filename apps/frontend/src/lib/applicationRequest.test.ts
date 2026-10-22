import { afterEach, expect, it, vi } from 'vitest';
import { applicationRequest } from './applicationRequest';
import { registerApplicationDispatcher } from './manager';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));
it('sends optimistic resource updates over the authenticated manager socket', async () => {
  const send = vi
    .fn()
    .mockResolvedValue({ chat: { version: 9, name: 'Renamed' } });
  cleanup.push(registerApplicationDispatcher(send));
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const result = await applicationRequest('/api/chats/chat-id', {
    method: 'PATCH',
    headers: { 'If-Match': '"8"' },
    body: JSON.stringify({ name: 'Renamed' }),
  });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'chat.rename',
      chatId: 'chat-id',
      version: 8,
      name: 'Renamed',
    }),
  );
  expect(result).toEqual({
    data: { version: 9, name: 'Renamed' },
    etag: '"9"',
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses cache-only initial model reads and explicit discovery refreshes', async () => {
  const send = vi.fn().mockResolvedValue({ models: [] });
  cleanup.push(registerApplicationDispatcher(send));
  await applicationRequest('/api/models');
  await applicationRequest('/api/models?chatId=chat&refresh=true');
  expect(send.mock.calls.map((args: unknown[]) => args[0])).toEqual([
    expect.objectContaining({ type: 'models.list', cachedOnly: true }),
    expect.objectContaining({
      type: 'models.list',
      chatId: 'chat',
      cachedOnly: false,
    }),
  ]);
});
it('fails closed for unmapped operations and aborted requests', async () => {
  const send = vi.fn();
  cleanup.push(registerApplicationDispatcher(send));
  await expect(applicationRequest('/api/private/native')).rejects.toThrow(
    'unavailable',
  );
  await expect(
    applicationRequest('/api/chats', { signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
