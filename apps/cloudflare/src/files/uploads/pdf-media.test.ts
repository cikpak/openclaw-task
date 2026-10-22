import { expect, it } from 'vitest';
import { UploadMedia } from './media.js';
import { fixture, addChat, settings } from './test-fixture.js';
import { encodeBase64 } from './codec.js';
import type {
  Gateway,
  GatewayAttachment,
} from '../../../../backend/src/gateway/types.js';
async function setup(images: boolean, text: boolean) {
  const f = fixture(),
    chat = addChat(f);
  const bytes = new TextEncoder().encode('%PDF-1.7\nprivate original\n%%EOF\n');
  const uploadId = (await f.service.handle(
    {
      type: 'upload.begin',
      commandId: crypto.randomUUID(),
      name: 'original.pdf',
      mimeType: 'application/pdf',
      size: bytes.length,
    },
    'owner',
  ))!.uploadId!;
  await f.service.handle(
    {
      type: 'upload.chunk',
      commandId: crypto.randomUUID(),
      uploadId,
      offset: 0,
      base64: encodeBase64(bytes),
    },
    'owner',
  );
  await f.service.handle(
    { type: 'upload.complete', commandId: crypto.randomUUID(), uploadId },
    'owner',
  );
  f.service.commitReferences(
    {
      type: 'conversation.message.send',
      commandId: crypto.randomUUID(),
      chatId: chat.id,
      text: 'read',
      uploadIds: [uploadId],
    },
    chat.id,
    'owner',
  );
  const mapping = { agentId: chat.agentId!, sessionKey: chat.sessionKey! };
  const media = new UploadMedia(f.service, {
    models: () =>
      Promise.resolve([
        {
          id: settings.model,
          available: true,
          input: images ? ['text', 'image'] : ['text'],
        },
      ]),
  } as unknown as Gateway);
  const nativePath =
    '/recovery/a/documents/.messenger-inputs/session/id/original.pdf';
  const nativeReadFiles = [
    {
      path: nativePath + '.page.png',
      mimeType: 'image/png',
      name: 'page-1.png',
    },
  ];
  if (text)
    nativeReadFiles.unshift({
      path: nativePath + '.text.txt',
      mimeType: 'text/plain',
      name: 'extracted-text.txt',
    });
  media.setHandoff(() =>
    Promise.resolve([
      {
        type: 'file',
        fileName: 'original.pdf',
        mimeType: 'application/pdf',
        nativePath,
        nativeReadFiles,
        content: '',
        sizeBytes: bytes.length,
        origin: 'file',
      } satisfies GatewayAttachment,
    ]),
  );
  return {
    media,
    mapping,
    attachments: f.service.prepareIds([uploadId], 'owner', chat.id),
  };
}
it('preserves text-only PDF consumption while explicitly limiting unavailable page images', async () => {
  const f = await setup(false, true);
  const result = await f.media.payload(f.attachments, settings, f.mapping);
  expect(result[0]!.nativeReadFiles).toHaveLength(1);
  expect(result[0]!.nativeReadFiles![0]!.mimeType).toBe('text/plain');
  expect(result[0]!.nativeReadNote).toContain('cannot inspect PDF page images');
  expect(result[0]!.nativePath).toContain('original.pdf');
});
it('requires image support for a PDF with no extractable text', async () => {
  const f = await setup(false, false);
  await expect(
    f.media.payload(f.attachments, settings, f.mapping),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_MODEL_INCOMPATIBLE' });
});
it('retains complete text and page image companions for an image-capable model', async () => {
  const f = await setup(true, true);
  const result = await f.media.payload(f.attachments, settings, f.mapping);
  expect(result[0]!.nativeReadFiles).toHaveLength(2);
  expect(result[0]!.nativeReadNote).toBeUndefined();
});
