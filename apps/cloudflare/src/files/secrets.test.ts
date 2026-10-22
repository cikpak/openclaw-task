import { afterEach, expect, it } from 'vitest';
import { Store } from '../../../backend/src/database.js';
import { managerSecrets, containerFileSecrets } from './secrets.js';
import { EngineFiles } from '../engine/files/service.js';
import type { EngineContext } from '../manager/types.js';
const closes: (() => void)[] = [];
afterEach(() => closes.splice(0).forEach((close) => close()));
it('keeps complete scanning in the DO and excludes R2 and signing private values from actual helper request bodies', async () => {
  const store = new Store(':memory:');
  closes.push(() => store.close());
  store.db.exec(
    'CREATE TABLE engine_credentials(id INTEGER PRIMARY KEY,helper TEXT,gateway TEXT)',
  );
  store.db
    .prepare('INSERT INTO engine_credentials VALUES(1,?,?)')
    .run('container-helper-secret', 'container-gateway-secret');
  const values = new Map<string, unknown>([
    ['managerIdentity', { privateKey: { d: 'DO-only-signing-private-d' } }],
    ['deviceToken', { token: 'native-issued-device-token' }],
  ]);
  const context = {
    store,
    env: {
      R2_ACCESS_KEY_ID: 'DO-only-R2-access',
      R2_SECRET_ACCESS_KEY: 'DO-only-R2-secret',
      OPENAI_API_KEY: 'container-provider-key',
    },
    state: {
      storage: {
        get: <T>(key: string) => Promise.resolve(values.get(key) as T),
      },
    },
  } as unknown as EngineContext;
  const complete = await managerSecrets(context);
  expect(complete).toEqual(
    expect.arrayContaining([
      'DO-only-R2-access',
      'DO-only-R2-secret',
      'DO-only-signing-private-d',
    ]),
  );
  const local = await containerFileSecrets(context);
  expect(local).toEqual(
    expect.arrayContaining([
      'container-helper-secret',
      'container-gateway-secret',
      'native-issued-device-token',
      'container-provider-key',
    ]),
  );
  expect(local.some((value) => value.startsWith('DO-only'))).toBe(false);
  const bodies: string[] = [];
  const files = new EngineFiles({
    storage: context.state.storage,
    secrets: () => containerFileSecrets(context),
    helper: (_path, init) => {
      if (typeof init?.body !== 'string')
        throw new Error('Expected private JSON body');
      bodies.push(init.body);
      return Promise.resolve(
        Response.json({
          path: '/recovery/workspace/documents/report.txt',
          documentsRoot: '/recovery/workspace/documents',
          name: 'report.txt',
          mimeType: 'text/plain',
          size: 1,
          modifiedAt: 1,
          digest: 'a'.repeat(64),
        }),
      );
    },
    catalog: {
      publish: () => Promise.reject(Error('unused')),
      policy: () => ({ documentsRoots: [], publications: [] }),
      records: () => [],
      revoke: () => Promise.resolve(),
    },
    mapping: () => null,
  });
  await files.metadata(
    { agentId: 'agent', sessionKey: 'session' },
    'documents/report.txt',
  );
  await files.inputMetadata(
    { agentId: 'agent', sessionKey: 'session' },
    'upload-id',
  );
  const current = await files.read(
    { agentId: 'agent', sessionKey: 'session' },
    'documents/report.txt',
  );
  await current.body?.cancel();
  const input = await files.readInput(
    { agentId: 'agent', sessionKey: 'session' },
    'upload-id',
  );
  await input.body?.cancel();
  await files.handoff({ agentId: 'agent', sessionKey: 'session', uploads: [] });
  expect(bodies).toHaveLength(5);
  for (const body of bodies) {
    expect(body).not.toContain('DO-only-R2-access');
    expect(body).not.toContain('DO-only-R2-secret');
    expect(body).not.toContain('DO-only-signing-private-d');
    expect(body).toContain(JSON.stringify('native-issued-device-token'));
  }
});
