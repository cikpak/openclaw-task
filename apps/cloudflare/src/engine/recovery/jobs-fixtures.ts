import { createHash } from 'node:crypto';
import { afterEach, vi } from 'vitest';
import type { EngineContext, ManagerEnv } from '../../manager/types.js';
import type { HelperJob, PrivateContainer } from '../container.js';
import { RecoveryJobs } from './jobs.js';
import { RecoveryObjects } from './objects.js';
import { Store } from '../../../../backend/src/database.js';

import type { LifecycleJob } from '../lifecycle/types.js';

import type { RecoveryDescriptor } from './types.js';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const digest = 'a'.repeat(64);
export const md5 = 'AAAAAAAAAAAAAAAAAAAAAA==';
export const descriptor: RecoveryDescriptor = {
  version: 1,
  checkpointId: 'attempt-capture',
  inventoryDigest: digest,
  archive: {
    key: 'recovery/attempt-capture/state.tar.gz',
    size: 12,
    sha256: digest,
    md5,
  },
  manifest: {
    key: 'recovery/attempt-capture/manifest.json',
    size: 30,
    sha256: digest,
    md5,
  },
  files: [
    {
      key: `files/attempt-capture/${digest}`,
      path: 'agents/work/documents/report.txt',
      size: 2,
      sha256: digest,
      md5,
      mode: 0o600,
      uid: 1000,
      gid: 1000,
    },
  ],
  counts: { entries: 2, userFiles: 1, databases: 0 },
};
export const capture: LifecycleJob = {
  id: 'attempt-capture',
  attemptId: 'attempt',
  bootId: 'boot',
  kind: 'capture',
};
export function setup() {
  const store = new Store(':memory:');
  stores.push(store);
  store.db.exec(
    'CREATE TABLE test_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
  store.db.exec(
    'CREATE TABLE recovery_references (id INTEGER PRIMARY KEY CHECK(id = 1), current TEXT NOT NULL, previous TEXT)',
  );
  const storage = {
    get: <T>(key: string): Promise<T | undefined> => {
      const row = store.db
        .prepare('SELECT value FROM test_kv WHERE key = ?')
        .get(key) as { value: string } | undefined;
      return Promise.resolve(row ? (JSON.parse(row.value) as T) : undefined);
    },
    put: (key: string, value: unknown) => {
      store.db
        .prepare(
          'INSERT INTO test_kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(key, JSON.stringify(value));
      return Promise.resolve();
    },
  };
  const states = new Map<string, HelperJob>();
  const startJob = vi.fn(
    (id: string, bootId: string, _action: string, _data?: unknown) => {
      void _action;
      void _data;
      if (!states.has(id))
        states.set(id, { operationId: id, bootId, status: 'running' });
      return Promise.resolve();
    },
  );
  const cancel = vi.fn((id: string, bootId: string) => {
    states.set(id, { operationId: id, bootId, status: 'cancelled' });
    return Promise.resolve();
  });
  const container = {
    startJob,
    cancel,
    job: (id: string) =>
      states.has(id)
        ? Promise.resolve(states.get(id)!)
        : Promise.reject(Error('Not started')),
  } as unknown as PrivateContainer;
  const head = vi.fn(() => Promise.resolve(null as unknown));
  const env = {
    R2_ORIGIN: 'https://0123456789abcdef.r2.cloudflarestorage.com',
    R2_BUCKET_NAME: 'private-test',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
    RECOVERY_BUCKET: { head },
  } as unknown as ManagerEnv;
  const context = {
    state: { storage },
    env,
    store,
  } as unknown as EngineContext;
  const objects = new RecoveryObjects(env);
  const identity = vi.fn(() =>
    Promise.resolve({ deviceId: 'expected-manager' }),
  );
  const create = () => new RecoveryJobs(context, container, objects, identity);
  return {
    store,
    states,
    startJob,
    cancel,
    head,
    context,
    objects,
    create,
    jobs: create(),
  };
}
export const receipt = {
  version: 1,
  checkpointId: descriptor.checkpointId,
  count: 3,
  objectsSha256: createHash('sha256')
    .update(
      JSON.stringify(
        [descriptor.archive, descriptor.manifest, ...descriptor.files]
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          .map(({ key, size, sha256 }) => [key, size, sha256]),
      ),
    )
    .digest('hex'),
};
export function complete(
  f: ReturnType<typeof setup>,
  id = capture.id,
  result: unknown = id.endsWith('-upload')
    ? { verification: receipt }
    : descriptor,
) {
  f.states.set(id, {
    operationId: id,
    bootId: capture.bootId,
    status: 'succeeded',
    result,
  });
}
