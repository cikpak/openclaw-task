import { expect, it, vi } from 'vitest';
import { request } from './api';
import { registerApplicationDispatcher } from './manager';
it('does not send JSON Content-Type for an empty authentication DELETE request', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetcher);
  await request('/api/session', { method: 'DELETE' });
  expect(fetcher).toHaveBeenCalledWith('/api/session', {
    credentials: 'same-origin',
    method: 'DELETE',
    headers: {},
  });
});
it('maps application versions into a manager command and derives the returned resource ETag', async () => {
  const dispatch = vi.fn().mockResolvedValue({ preferences: { version: 9 } });
  registerApplicationDispatcher(dispatch);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const result = await request('/api/preferences', {
    method: 'PATCH',
    body: '{}',
    headers: { 'If-Match': '"8"' },
  });
  expect(result.etag).toBe('"9"');
  expect(dispatch).toHaveBeenCalledWith({
    type: 'preferences.update',
    commandId: expect.any(String) as string,
    version: 8,
    preferences: {},
  });
  expect(fetcher).not.toHaveBeenCalled();
});
