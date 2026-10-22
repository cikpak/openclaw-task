import { expect, it, vi } from 'vitest';
import { RecoveryObjects } from './objects.js';
import { assertVerification, verificationReceipt } from './verification.js';
import {
  setup,
  capture,
  complete,
  descriptor,
  receipt,
  md5,
} from './jobs-fixtures.js';
import type { ManagerEnv } from '../../manager/types.js';

it('fingerprints the unique exact objects independently of descriptor ordering', async () => {
  expect(await verificationReceipt(descriptor)).toEqual(receipt);
  const reordered = {
    ...descriptor,
    files: [...descriptor.files, descriptor.files[0]!],
  };
  expect(await verificationReceipt(reordered)).toEqual(receipt);
  for (const value of [
    undefined,
    { ...receipt, count: 2 },
    { ...receipt, checkpointId: 'stale' },
    { ...receipt, objectsSha256: 'b'.repeat(64) },
    { ...receipt, extra: true },
  ])
    await expect(assertVerification(descriptor, value)).rejects.toThrow(
      'verification mismatch',
    );
});

it('accepts only authenticated upload completion for the exact boot, operation and receipt', async () => {
  const f = setup();
  await f.jobs.start(capture);
  complete(f);
  await f.jobs.status(capture.id);
  const payload = f.startJob.mock.calls.at(-1)?.[3] as {
    readbackGrants: { key: string }[];
  };
  expect(payload.readbackGrants.map((grant) => grant.key)).toEqual([
    descriptor.archive.key,
    descriptor.manifest.key,
    descriptor.files[0]!.key,
  ]);
  const id = `${capture.id}-upload`;
  complete(f, id, {
    verification: { ...receipt, objectsSha256: '0'.repeat(64) },
  });
  await expect(f.jobs.status(capture.id)).rejects.toThrow(
    'verification mismatch',
  );
  complete(f, id);
  f.states.get(id)!.operationId = 'wrong-operation';
  await expect(f.jobs.status(capture.id)).rejects.toThrow('Stale');
  complete(f, id);
  f.states.get(id)!.bootId = 'old-boot';
  await expect(f.jobs.status(capture.id)).rejects.toThrow('Stale');
  complete(f, id);
  const status = await f.create().status(capture.id);
  await expect(f.create().verify(status.checkpoint!)).resolves.toBeUndefined();
  await expect(
    f
      .create()
      .verify({ ...status.checkpoint!, manifestSha256: '0'.repeat(64) }),
  ).rejects.toThrow('completion unavailable');
});

it('never accepts stale cancellation status as a settled upload', async () => {
  const f = setup();
  await f.jobs.start(capture);
  complete(f);
  await f.jobs.status(capture.id);
  await f.jobs.cancel(capture);
  f.states.get(`${capture.id}-upload`)!.bootId = 'old-boot';
  await expect(f.jobs.status(capture.id)).rejects.toThrow('Stale');
});

it('manager verification uses only metadata and refuses missing/changed objects', async () => {
  const head = vi.fn().mockResolvedValue({
    size: 12,
    checksums: { md5: new Uint8Array(16).buffer },
  });
  const get = vi.fn(() => {
    throw Error('Object body must never enter manager');
  });
  const objects = new RecoveryObjects({
    RECOVERY_BUCKET: { head, get },
  } as unknown as ManagerEnv);
  const value = {
    ...descriptor,
    archive: { ...descriptor.archive, size: 12, md5 },
    manifest: { ...descriptor.manifest, size: 12, md5 },
    files: [],
  };
  const checkpoint = {
    generation: value.checkpointId,
    manifestKey: value.manifest.key,
    manifestSha256: value.manifest.sha256,
    descriptor: { ...value },
  };
  await objects.verify(checkpoint);
  expect(get).not.toHaveBeenCalled();
  head.mockResolvedValueOnce(null);
  await expect(objects.verify(checkpoint)).rejects.toThrow('missing');
  head.mockResolvedValueOnce({ size: 11 });
  await expect(objects.verify(checkpoint)).rejects.toThrow('incomplete');
  head.mockResolvedValueOnce({
    size: 12,
    checksums: { md5: new Uint8Array(16).fill(1).buffer },
  });
  await expect(objects.verify(checkpoint)).rejects.toThrow('metadata changed');
  await expect(
    objects.verify(checkpoint, { shouldCancel: () => true }),
  ).rejects.toThrow('cancelled');
  expect(get).not.toHaveBeenCalled();
});
