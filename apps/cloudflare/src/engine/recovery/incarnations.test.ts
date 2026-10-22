import { expect, it } from 'vitest';
import { assertFileIncarnations } from './incarnations.js';
import type { RecoveryDescriptor } from './types.js';
const sha = 'a'.repeat(64);
const descriptor = (
  id: string,
  key = `files/${id}/${sha}`,
  size = 4,
): RecoveryDescriptor => ({
  version: 1,
  checkpointId: id,
  archive: {
    key: `recovery/${id}/internal.tar.gz`,
    sha256: sha,
    md5: 'YWFhYWFhYWFhYWFhYWFhYQ==',
    size: 4,
  },
  manifest: {
    key: `recovery/${id}/manifest.json`,
    sha256: sha,
    md5: 'YWFhYWFhYWFhYWFhYWFhYQ==',
    size: 4,
  },
  files: [
    {
      path: 'documents/answer.txt',
      key,
      sha256: sha,
      size,
      md5: 'YWFhYWFhYWFhYWFhYWFhYQ==',
      mode: 420,
      uid: 1000,
      gid: 1000,
    },
  ],
  inventoryDigest: sha,
  counts: { entries: 1, userFiles: 1, databases: 0 },
});
it('permits fresh generation keys and exact current-object reuse, including legacy current keys', () => {
  expect(() => assertFileIncarnations(descriptor('new'))).not.toThrow();
  const legacy = descriptor('old', `files/${sha}`);
  expect(() =>
    assertFileIncarnations(descriptor('new', legacy.files[0]!.key), legacy),
  ).not.toThrow();
  const current = descriptor('old');
  expect(() =>
    assertFileIncarnations(descriptor('new', current.files[0]!.key), current),
  ).not.toThrow();
});
it('rejects resurrection of an uncommitted incarnation and inconsistent metadata', () => {
  expect(() =>
    assertFileIncarnations(
      descriptor('new', `files/deleted/${sha}`),
      descriptor('old'),
    ),
  ).toThrow('incarnation');
  expect(() =>
    assertFileIncarnations(descriptor('new', `files/${sha}`)),
  ).toThrow('incarnation');
  expect(() =>
    assertFileIncarnations(
      descriptor('new', `files/old/${sha}`, 5),
      descriptor('old'),
    ),
  ).toThrow('incarnation');
  expect(() => assertFileIncarnations(descriptor('../outside'))).toThrow(
    'generation',
  );
  const duplicate = descriptor('new');
  duplicate.files.push({ ...duplicate.files[0]!, size: 5 });
  expect(() => assertFileIncarnations(duplicate)).toThrow('incarnation');
});
