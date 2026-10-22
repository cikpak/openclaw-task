import { afterEach, expect, it } from 'vitest';
import { Store } from '../../../backend/src/database.js';
import { normalizedTestSettings } from '../../../backend/test/fake-gateway.js';
import { InputPublications } from './input-audit.js';
import type { UploadService } from './uploads/service.js';
import type { RecoveryDescriptor } from '../engine/recovery/types.js';
const closes: (() => void)[] = [];
afterEach(() => closes.splice(0).forEach((close) => close()));
function setup() {
  const store = new Store(':memory:');
  closes.push(() => store.close());
  const chatId = crypto.randomUUID(),
    id = crypto.randomUUID();
  store.reserveChat({
    id: chatId,
    name: 'Inputs',
    status: 'idle',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    settings: normalizedTestSettings,
    agentId: 'agent',
    sessionKey: 'session',
    creationId: crypto.randomUUID(),
  });
  store.db.exec(
    'CREATE TABLE input_file_paths(id TEXT PRIMARY KEY,path TEXT,object_key TEXT)',
  );
  const path = `/recovery/workspace/documents/.messenger-inputs/session/${id}/input.txt`;
  store.db
    .prepare('INSERT INTO input_file_paths VALUES (?, ?, ?)')
    .run(id, path, 'files/previous/object');
  const uploads = {
    lookup: () => ({ id, chatId }),
  } as unknown as UploadService;
  const publications = new InputPublications(store, uploads);
  const digest = 'a'.repeat(64),
    key = `files/current/${digest}`;
  const descriptor = {
    files: [{ path: path.slice('/recovery/'.length), sha256: digest, key }],
  } as RecoveryDescriptor;
  return { store, id, path, digest, key, descriptor, publications };
}
it('pins safe input content to its audited digest, preventing stale or changed publication', async () => {
  const f = setup();
  await f.publications.audit(() =>
    Promise.resolve({ digest: f.digest, size: 64, modifiedAt: 1 }),
  );
  f.publications.commit(f.descriptor);
  expect(
    f.store.db.prepare('SELECT object_key FROM input_file_paths').get(),
  ).toEqual({ object_key: f.key });
  f.publications.commit({
    files: [{ ...f.descriptor.files[0], sha256: 'b'.repeat(64) }],
  } as RecoveryDescriptor);
  expect(f.publications.get(f.id)?.eligible).toBe(false);
  expect(
    f.store.db.prepare('SELECT object_key FROM input_file_paths').get(),
  ).toEqual({ object_key: null });
});
it('keeps a live-denied credential input private after checkpoint while preserving its recovery descriptor', async () => {
  const f = setup();
  const original = JSON.stringify(f.descriptor);
  await f.publications.audit(() => Promise.reject(Error('Known secret found')));
  expect(f.publications.get(f.id)?.eligible).toBe(false);
  f.publications.commit(f.descriptor);
  expect(f.publications.get(f.id)?.eligible).toBe(false);
  expect(
    f.store.db.prepare('SELECT object_key FROM input_file_paths').get(),
  ).toEqual({ object_key: null });
  expect(JSON.stringify(f.descriptor)).toBe(original);
  expect(f.descriptor.files[0]!.path).toContain('.messenger-inputs');
});
