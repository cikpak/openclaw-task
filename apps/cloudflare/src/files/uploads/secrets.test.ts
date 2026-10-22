import { expect, it } from 'vitest';
import { fixture, begin } from './test-fixture.js';
import { encodeBase64 } from './codec.js';
it('rejects an exact known account secret before final object or completion acknowledgement', async () => {
  const f = fixture(),
    bytes = new TextEncoder().encode(
      `User attachment includes ${f.context.env.R2_SECRET_ACCESS_KEY!}`,
    );
  const { id } = await begin(f, bytes);
  await f.service.handle(
    {
      type: 'upload.chunk',
      commandId: crypto.randomUUID(),
      uploadId: id,
      offset: 0,
      base64: encodeBase64(bytes),
    },
    'owner',
  );
  await expect(
    f.service.handle(
      { type: 'upload.complete', commandId: crypto.randomUUID(), uploadId: id },
      'owner',
    ),
  ).rejects.toMatchObject({ code: 'UPLOAD_SENSITIVE_CONTENT', status: 422 });
  const row = f.service.lookup(id)!;
  expect(row.status).toBe('staging');
  expect(f.data.has(row.key)).toBe(false);
  expect(
    f.store.db.prepare('SELECT sum(size) AS size FROM staged_uploads').get(),
  ).toEqual({ size: bytes.length });
  expect(() => f.service.prepareIds([id], 'owner')).toThrow('finish uploading');
});
it('finds known secret bytes inside binary PDF without guessing other confidential contents', async () => {
  const f = fixture(),
    prefix = new TextEncoder().encode('%PDF-1.7\n'),
    secret = new TextEncoder().encode(f.context.env.R2_SECRET_ACCESS_KEY);
  const bytes = new Uint8Array(prefix.length + secret.length + 2);
  bytes.set(prefix);
  bytes[prefix.length] = 255;
  bytes.set(secret, prefix.length + 1);
  bytes[bytes.length - 1] = 254;
  const command = {
    type: 'upload.begin',
    commandId: crypto.randomUUID(),
    name: 'input.pdf',
    mimeType: 'application/pdf',
    size: bytes.length,
  } as const;
  const id = (await f.service.handle(command, 'owner'))!.uploadId!;
  await f.service.handle(
    {
      type: 'upload.chunk',
      commandId: crypto.randomUUID(),
      uploadId: id,
      offset: 0,
      base64: encodeBase64(bytes),
    },
    'owner',
  );
  await expect(
    f.service.handle(
      { type: 'upload.complete', commandId: crypto.randomUUID(), uploadId: id },
      'owner',
    ),
  ).rejects.toMatchObject({ code: 'UPLOAD_SENSITIVE_CONTENT' });
  expect(f.data.has(f.service.lookup(id)!.key)).toBe(false);
});
