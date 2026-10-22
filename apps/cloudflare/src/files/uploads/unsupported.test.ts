import { expect, it, vi } from 'vitest';
import { ManagerTransport } from '../../../../backend/src/transport/manager.js';
import type { ManagerHandlers } from '../../../../backend/src/transport/manager.js';
import { fixture } from './test-fixture.js';

it('unsupported wire MIME returns 415 without reserving an upload, ownership or command', async () => {
  const f = fixture();
  const claim = vi.spyOn(f.authorization, 'claim');
  const transport = new ManagerTransport(
    { authorize: () => Promise.resolve() },
    {
      'upload.begin': (command) => f.service.handle(command, 'owner'),
    } as ManagerHandlers,
  );
  const commandId = crypto.randomUUID();
  const result = await transport.dispatch(
    {
      type: 'upload.begin',
      commandId,
      name: 'document.html',
      mimeType: 'text/html',
      size: 10,
    },
    'correlation',
  );
  expect(result).toMatchObject({
    commandId,
    ok: false,
    error: { status: 415, code: 'UNSUPPORTED_ATTACHMENT' },
  });
  for (const table of [
    'staged_uploads',
    'staged_upload_commands',
    'manager_resources',
  ])
    expect(
      f.store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get(),
    ).toEqual({ count: 0 });
  expect(claim).not.toHaveBeenCalled();
  expect(f.data.size).toBe(0);
});
