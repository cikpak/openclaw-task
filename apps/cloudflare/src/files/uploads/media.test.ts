import { encodeBase64 } from './codec.js';
import { expect, it, vi } from 'vitest';
import { UploadMedia } from './media.js';
import type { Gateway } from '../../../../backend/src/gateway/types.js';
import type { ManagerCommand } from '@messenger/contracts';
import { fixture, complete, addChat, settings } from './test-fixture.js';
it('validates staging offline and hands off exact signed private objects only during dispatch', async () => {
  const f = fixture(),
    upload = await complete(f),
    chat = addChat(f);
  const mapping = { agentId: chat.agentId!, sessionKey: chat.sessionKey! };
  const command = {
    type: 'conversation.message.send',
    commandId: crypto.randomUUID(),
    chatId: chat.id,
    text: '',
    uploadIds: [upload.id],
  } as ManagerCommand;
  const models = vi.fn(() =>
    Promise.resolve([{ id: settings.model, available: true, input: ['text'] }]),
  );
  const media = new UploadMedia(f.service, {
    models,
    cachedModels: () => null,
  } as unknown as Gateway);
  const handoff = vi.fn(() => Promise.resolve([]));
  media.setHandoff(handoff);
  const attachments = await media.prepare(settings, [upload.id]);
  expect(models).not.toHaveBeenCalled();
  expect(handoff).not.toHaveBeenCalled();
  f.service.commitReferences(command, chat.id, 'owner');
  await media.payload(attachments, settings, mapping);
  expect(handoff).toHaveBeenCalledOnce();
  const delivered = handoff.mock.calls[0] as unknown as [
    unknown,
    { url: string; id: string; sha256: string }[],
  ];
  const url = new URL(delivered[1][0]!.url);
  expect(url.hostname).toBe('012345.r2.cloudflarestorage.com');
  expect(url.pathname).toBe(`/private/staging/uploads/${upload.id}/content`);
  expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  expect(delivered[1][0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
});
it('hands off the full ten MiB browser allowance without applying native base64 envelope limits', async () => {
  const f = fixture(),
    chat = addChat(f),
    ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const bytes = new Uint8Array(5 * 1024 * 1024).fill(97);
    const id = (await f.service.handle(
      {
        type: 'upload.begin',
        commandId: crypto.randomUUID(),
        name: `input-${i}.txt`,
        mimeType: 'text/plain',
        size: bytes.length,
      },
      'owner',
    ))!.uploadId!;
    for (let offset = 0; offset < bytes.length; offset += 48 * 1024)
      await f.service.handle(
        {
          type: 'upload.chunk',
          commandId: crypto.randomUUID(),
          uploadId: id,
          offset,
          base64: encodeBase64(bytes.subarray(offset, offset + 48 * 1024)),
        },
        'owner',
      );
    await f.service.handle(
      { type: 'upload.complete', commandId: crypto.randomUUID(), uploadId: id },
      'owner',
    );
    ids.push(id);
  }
  const command = {
    type: 'conversation.message.send',
    commandId: crypto.randomUUID(),
    chatId: chat.id,
    text: '',
    uploadIds: ids,
  } satisfies ManagerCommand;
  const attachments = await f.service.prepare(command, 'owner');
  f.service.commitReferences(command, chat.id, 'owner');
  const media = new UploadMedia(f.service, {
    maxPayload: 1024 * 1024,
    models: () =>
      Promise.resolve([
        { id: settings.model, available: true, input: ['text'] },
      ]),
  } as unknown as Gateway);
  const handoff = vi.fn(() => Promise.resolve([]));
  media.setHandoff(handoff);
  await media.payload(attachments, settings, {
    agentId: chat.agentId!,
    sessionKey: chat.sessionKey!,
  });
  const rows = (
    handoff.mock.calls[0] as unknown as [unknown, { size: number }[]]
  )[1];
  expect(rows.reduce((sum, row) => sum + row.size, 0)).toBe(10 * 1024 * 1024);
});
