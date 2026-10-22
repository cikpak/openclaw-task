import { encodeBase64 } from './codec.js';
import { afterEach, vi } from 'vitest';
import { Store } from '../../../../backend/src/database.js';
import { ManagerAuthorization } from '../../manager/authorization.js';
import type { EngineContext, ManagerEnv } from '../../manager/types.js';
import { UploadService } from './service.js';
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
export const settings = {
  model: 'provider/model',
  thinkingLevel: 'off',
  fastMode: false,
};
export function fixture() {
  const store = new Store(':memory:');
  stores.push(store);
  const data = new Map<string, Uint8Array>();
  const bucket = {
    put: vi.fn((key: string, value: Uint8Array) => {
      data.set(key, new Uint8Array(value));
      return Promise.resolve({ size: value.length });
    }),
    get: vi.fn((key: string) => {
      const value = data.get(key);
      return Promise.resolve(
        value
          ? {
              size: value.length,
              arrayBuffer: () => Promise.resolve(new Uint8Array(value).buffer),
            }
          : null,
      );
    }),
    list: vi.fn(({ prefix }: { prefix: string }) =>
      Promise.resolve({
        objects: [...data.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      }),
    ),
    delete: vi.fn((key: string) => {
      data.delete(key);
      return Promise.resolve();
    }),
  };
  const env = {
    RECOVERY_BUCKET: bucket,
    R2_ORIGIN: 'https://012345.r2.cloudflarestorage.com',
    R2_BUCKET_NAME: 'private',
    R2_ACCESS_KEY_ID: 'test-access',
    R2_SECRET_ACCESS_KEY: 'test-secret',
  } as unknown as ManagerEnv;
  const authorization = new ManagerAuthorization(env, store);
  const context = {
    store,
    env,
    state: { storage: { get: () => Promise.resolve(undefined) } },
  } as unknown as EngineContext;
  const service = new UploadService(context, authorization);
  return { store, data, bucket, service, context, authorization };
}
export async function begin(
  f: ReturnType<typeof fixture>,
  bytes = new TextEncoder().encode('hello'),
  name = 'hello.txt',
) {
  const command = {
    type: 'upload.begin',
    commandId: crypto.randomUUID(),
    name,
    mimeType: 'text/plain',
    size: bytes.length,
  } as const;
  const begun = await f.service.handle(command, 'owner');
  const id = begun!.uploadId!;
  return { id, command, bytes };
}
export async function complete(f: ReturnType<typeof fixture>) {
  const upload = await begin(f);
  await f.service.handle(
    {
      type: 'upload.chunk',
      commandId: crypto.randomUUID(),
      uploadId: upload.id,
      offset: 0,
      base64: encodeBase64(upload.bytes),
    },
    'owner',
  );
  await f.service.handle(
    {
      type: 'upload.complete',
      commandId: crypto.randomUUID(),
      uploadId: upload.id,
    },
    'owner',
  );
  return upload;
}
export function addChat(
  f: ReturnType<typeof fixture>,
  id = crypto.randomUUID(),
) {
  f.store.reserveChat({
    id,
    name: 'Chat',
    status: 'idle',
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    unread: false,
    settings,
    agentId: `agent-${id}`,
    sessionKey: `session-${id}`,
    creationId: crypto.randomUUID(),
  });
  f.authorization.claim('chat', id, 'owner');
  return f.store.getChat(id);
}
