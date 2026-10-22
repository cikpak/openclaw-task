import { afterEach, expect, it } from 'vitest';
import { Store } from '../../../backend/src/database.js';
import { normalizedTestSettings } from '../../../backend/test/fake-gateway.js';
import { ManagerAuthorization } from '../manager/authorization.js';
import type { ManagerEnv } from '../manager/types.js';
import { FileCatalog } from './catalog.js';
import type { RecoveryDescriptor } from '../engine/recovery/types.js';
import { ManagerEvents } from '../manager/events.js';
import type { SocketAuthorization } from '../manager/socket-auth.js';
import { BrowserBoundary } from './boundary.js';
import { tools } from '../../../backend/src/chats/tools.js';
const closes: (() => void)[] = [];
afterEach(() => closes.splice(0).forEach((close) => close()));
function setup() {
  const store = new Store(':memory:');
  closes.push(() => store.close());
  const auth = new ManagerAuthorization({} as ManagerEnv, store);
  const id = crypto.randomUUID();
  store.reserveChat({
    id,
    name: 'Safe',
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
  auth.claim('chat', id, 'owner');
  return { store, auth, id, catalog: new FileCatalog(store, auth) };
}
it('publishes only classified documents with opaque IDs and exact audited digest before asleep delivery', async () => {
  const f = setup();
  const digest = 'a'.repeat(64);
  const input = {
    agentId: 'agent',
    sessionKey: 'session',
    path: '/recovery/workspace/documents/report.txt',
    documentsRoot: '/recovery/workspace/documents',
    name: 'report.txt',
    mimeType: 'text/plain',
    size: 12,
    modifiedAt: 1,
    digest,
  };
  const file = await f.catalog.publish(input);
  expect(file.id).not.toContain('report');
  expect(f.catalog.policy().publications).toHaveLength(1);
  const descriptor = {
    files: [
      {
        path: 'workspace/documents/report.txt',
        key: `files/one/${digest}`,
        sha256: digest,
      },
    ],
  } as RecoveryDescriptor;
  f.catalog.commit(descriptor);
  expect(f.catalog.get(file.id).objectKey).toBe(`files/one/${digest}`);
  await f.catalog.revoke(input, 'documents/report.txt');
  expect(f.catalog.policy().publications).toHaveLength(0);
  f.catalog.commit(descriptor);
  expect(() => f.catalog.get(file.id)).toThrow();
  await f.catalog.publish(input);
  f.catalog.commit({
    files: [{ ...descriptor.files[0], sha256: 'b'.repeat(64) }],
  } as RecoveryDescriptor);
  expect(() => f.catalog.get(file.id)).toThrow();
});
it('suppresses internal and unclassified paths even when they reside under documents', () => {
  const f = setup();
  const input = {
    agentId: 'agent',
    sessionKey: 'session',
    path: '/recovery/workspace/documents/AGENTS.md',
    documentsRoot: '/recovery/workspace/documents',
    name: 'AGENTS.md',
    mimeType: 'text/markdown',
    size: 12,
    modifiedAt: 1,
    digest: 'a'.repeat(64),
  };
  expect(() => f.catalog.publish(input)).toThrow();
  expect(f.catalog.all()).toEqual([]);
});
it('persists concise safe tool summaries before broadcast so reconnect cache retains them', () => {
  const f = setup();
  const state = { getWebSockets: () => [] } as unknown as DurableObjectState;
  const events = new ManagerEvents(
    state,
    f.store,
    f.auth,
    {} as SocketAuthorization,
    new BrowserBoundary(() => f.catalog.policy()),
  );
  events.publish({
    type: 'conversation.tool',
    chatId: f.id,
    tool: {
      id: 'run:write',
      name: 'write',
      status: 'completed',
      parameters: '',
      output: 'Wrote report.txt',
    },
    generation: 'native',
    sequence: 0,
  });
  expect(tools(f.store, f.id)).toEqual([
    {
      id: 'run:write',
      name: 'write',
      status: 'completed',
      parameters: '',
      output: 'Wrote report.txt',
    },
  ]);
  expect(
    f.store.db.prepare('SELECT sequence FROM manager_stream').get(),
  ).toEqual({ sequence: 1 });
});
