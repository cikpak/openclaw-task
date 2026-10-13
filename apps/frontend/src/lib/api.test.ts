import { expect, it, vi } from 'vitest';
import { request } from './api';
it('does not send JSON Content-Type for an empty DELETE request', async () => {
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
it('preserves server ETags and sends JSON Content-Type for actual JSON bodies', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response('{}', { status: 200, headers: { ETag: '"9"' } }),
    );
  vi.stubGlobal('fetch', fetcher);
  const result = await request('/api/preferences', {
    method: 'PATCH',
    body: '{}',
    headers: { 'If-Match': '"8"' },
  });
  expect(result.etag).toBe('"9"');
  expect(fetcher).toHaveBeenCalledWith('/api/preferences', {
    credentials: 'same-origin',
    method: 'PATCH',
    body: '{}',
    headers: { 'Content-Type': 'application/json', 'If-Match': '"8"' },
  });
});
