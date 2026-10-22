import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../../../../backend/src/database.js';
import type { EngineContext, ManagerEnv } from '../../manager/types.js';
import type { HelperJob, PrivateContainer } from '../container.js';
import type { LifecycleJob } from '../lifecycle/types.js';
import { RecoveryJobs } from './jobs.js';
import { RecoveryObjects } from './objects.js';
import type { RecoveryDescriptor, TransferGrant } from './types.js';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const digest = 'a'.repeat(64);
const md5 = 'AAAAAAAAAAAAAAAAAAAAAA==';
const descriptor: RecoveryDescriptor = {
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
      key: `files/${digest}`,
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
const capture: LifecycleJob = {
  id: 'attempt-capture',
  attemptId: 'attempt',
  bootId: 'boot',
  kind: 'capture',
};
function setup() {
  const store = new Store(':memory:');
  stores.push(store);
  store.db.exec(
    'CREATE TABLE test_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
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
function complete(
  f: ReturnType<typeof setup>,
  id = capture.id,
  result: unknown = descriptor,
) {
  f.states.set(id, {
    operationId: id,
    bootId: capture.bootId,
    status: 'succeeded',
    result,
  });
}

it('resumes the same capture and upload operation after manager recreation with exact signed grants', async () => {
  const f = setup();
  await f.jobs.start(capture);
  complete(f);
  expect((await f.create().status(capture.id)).state).toBe('running');
  const upload = f.startJob.mock.calls.find((call) => call[2] === 'upload')!;
  expect(upload.slice(0, 3)).toEqual([
    `${capture.id}-upload`,
    capture.bootId,
    'upload',
  ]);
  const data = upload[3] as { grants: TransferGrant[] };
  expect(data.grants.map((grant) => grant.key)).toEqual([
    descriptor.archive.key,
    descriptor.manifest.key,
    descriptor.files[0]!.key,
  ]);
  for (const grant of data.grants) {
    const url = new URL(grant.url);
    expect(url.origin).toBe(
      'https://0123456789abcdef.r2.cloudflarestorage.com',
    );
    expect(decodeURIComponent(url.pathname)).toBe(`/private-test/${grant.key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain(
      'content-md5',
    );
    expect(grant.headers?.['content-md5']).toBe(md5);
  }
  await f.create().start(capture);
  expect(f.startJob.mock.calls.at(-1)?.slice(0, 3)).toEqual(upload.slice(0, 3));
  expect(f.startJob.mock.calls.at(-1)?.[3]).toEqual(upload[3]);
  complete(f, `${capture.id}-upload`);
  const status = await f.create().status(capture.id);
  expect(status).toMatchObject({
    id: capture.id,
    attemptId: capture.attemptId,
    bootId: capture.bootId,
    state: 'complete',
    checkpoint: {
      generation: descriptor.checkpointId,
      manifestKey: descriptor.manifest.key,
    },
  });
});
it('signs restore reads for exactly the committed generation', async () => {
  const f = setup();
  const job: LifecycleJob = {
    ...capture,
    id: 'attempt-restore',
    kind: 'restore',
    checkpoint: {
      generation: descriptor.checkpointId,
      manifestKey: descriptor.manifest.key,
      manifestSha256: descriptor.manifest.sha256,
      descriptor: { ...descriptor },
    },
  };
  await f.jobs.start(job);
  const data = f.startJob.mock.calls[0]?.[3] as {
    descriptor: RecoveryDescriptor;
    grants: TransferGrant[];
  };
  expect(data.descriptor).toEqual(descriptor);
  expect(data.grants).toHaveLength(3);
  expect(
    data.grants.every(
      (grant) =>
        !grant.headers &&
        new URL(grant.url).searchParams.get('X-Amz-SignedHeaders') === 'host',
    ),
  ).toBe(true);
});
it('reuses only files with matching size and stored checksum', async () => {
  const f = setup();
  f.head.mockResolvedValue({
    size: descriptor.files[0]!.size,
    checksums: { md5: new Uint8Array(16).buffer },
  });
  await f.jobs.start(capture);
  complete(f);
  await f.jobs.status(capture.id);
  const data = f.startJob.mock.calls.find(
    (call) => call[2] === 'upload',
  )?.[3] as { reuse: string[]; grants: TransferGrant[] };
  expect(data.reuse).toEqual([descriptor.files[0]!.key]);
  expect(data.grants.map((grant) => grant.key)).toEqual([
    descriptor.archive.key,
    descriptor.manifest.key,
  ]);
});
it('cancellation before start is durable and cannot be resurrected by a retry', async () => {
  const f = setup();
  await f.jobs.cancel(capture);
  await f.create().start(capture);
  expect((await f.create().status(capture.id)).state).toBe('cancelled');
  expect(f.startJob).not.toHaveBeenCalled();
});
it('cancelling a completed capture never starts its upload stage', async () => {
  const f = setup();
  await f.jobs.start(capture);
  complete(f);
  await f.jobs.cancel(capture);
  expect((await f.create().status(capture.id)).state).toBe('cancelled');
  expect(f.startJob.mock.calls.map((call) => call[2])).toEqual(['capture']);
});

it('cancels upload by its stable operation ID and preserves the cancelled fence across recreation', async () => {
  const f = setup();
  await f.jobs.start(capture);
  complete(f);
  await f.jobs.status(capture.id);
  await f.jobs.cancel(capture);
  expect(f.cancel).toHaveBeenLastCalledWith(
    `${capture.id}-upload`,
    capture.bootId,
  );
  expect((await f.create().status(capture.id)).state).toBe('cancelled');
  const starts = f.startJob.mock.calls.length;
  await f.create().start(capture);
  expect(f.startJob).toHaveBeenCalledTimes(starts);
});

it('rejects stale boot results and refuses reused operation identities', async () => {
  const f = setup();
  await f.jobs.start(capture);
  f.states.set(capture.id, {
    operationId: capture.id,
    bootId: 'old-boot',
    status: 'succeeded',
    result: descriptor,
  });
  await expect(f.jobs.status(capture.id)).rejects.toThrow('Stale');
  await expect(
    f.create().start({ ...capture, attemptId: 'different-attempt' }),
  ).rejects.toThrow('identity reused');
});

it('retains and retries the exact operation after a lost start acknowledgment', async () => {
  const f = setup();
  f.startJob.mockRejectedValueOnce(Error('Lost ACK'));
  await expect(f.jobs.start(capture)).rejects.toThrow('Lost ACK');
  await f.create().start(capture);
  expect(f.startJob).toHaveBeenCalledTimes(2);
  expect(f.startJob.mock.calls[1]).toEqual(f.startJob.mock.calls[0]);
});

it.each(['failed', 'cancelled'] as const)(
  'reports helper %s without initiating an upload',
  async (status) => {
    const f = setup();
    await f.jobs.start(capture);
    f.states.set(capture.id, {
      operationId: capture.id,
      bootId: capture.bootId,
      status,
    });
    expect((await f.jobs.status(capture.id)).state).toBe(status);
    expect(f.startJob).toHaveBeenCalledTimes(1);
  },
);
