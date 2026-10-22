import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../../../backend/src/database.js';
import { ManagerApplication } from './application.js';
import { ManagerAuthorization } from './authorization.js';
import { BrowserBoundary } from '../files/boundary.js';
import type { ManagerCommand } from '@messenger/contracts';
import { recentMessages } from './cached.js';
import type { Grant, ManagerEngine, ManagerEnv } from './types.js';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const settings = {
  model: 'configured/model',
  thinkingLevel: 'off',
  fastMode: false,
};
function setup(engine?: ManagerEngine, boundary?: BrowserBoundary) {
  const store = new Store(':memory:');
  stores.push(store);
  const grant: Grant = {
    id: 'grant',
    accountId: 'owner',
    sessionId: 'session',
    managerId: 'primary',
    expiresAt: Date.now() + 60_000,
  };
  const env = {
    APP_ORIGIN: 'https://messenger.example',
    BACKEND: { fetch: () => Promise.resolve(Response.json({ grant })) },
  } as unknown as ManagerEnv;
  const authorization = new ManagerAuthorization(env, store);
  const application = new ManagerApplication(
    store,
    authorization,
    engine,
    (work) => void work.catch(() => {}),
    undefined,
    boundary,
  );
  return {
    store,
    grant,
    authorization,
    application,
    dispatch: (command: unknown) =>
      application.transport(grant).dispatch(command, 'test'),
  };
}
async function create(app: ReturnType<typeof setup>) {
  const command = {
    type: 'chat.create',
    commandId: crypto.randomUUID(),
    settings,
    initialMessage: { text: 'Original accepted work' },
  };
  const result = await app.dispatch(command);
  expect(result.ok).toBe(true);
  if (!result.ok || !result.data.chat) throw Error('Creation failed');
  return { command, result, id: result.data.chat.id };
}
it('durably accepts creation and send without an engine, retaining immutable receipts', async () => {
  const app = setup();
  const created = await create(app);
  const chat = app.store.getChat(created.id);
  chat.name = 'Changed later';
  app.store.saveChat(chat);
  expect(await app.dispatch(created.command)).toEqual(created.result);
  const command = {
    type: 'conversation.message.send',
    commandId: crypto.randomUUID(),
    chatId: created.id,
    text: 'Accepted while asleep',
  };
  const accepted = await app.dispatch(command);
  expect(accepted.ok).toBe(true);
  expect(await app.dispatch(command)).toEqual(accepted);
  expect(app.store.pending(created.id)).toHaveLength(2);
  const receipt = await app.dispatch({
    type: 'command.receipt.request',
    commandId: crypto.randomUUID(),
    receiptCommandId: created.command.commandId,
  });
  expect(receipt.ok && receipt.data.receipt?.state).toBe('accepted');
  app.authorization.revoke(app.grant.sessionId);
  expect(app.store.pending(created.id)).toHaveLength(2);
  expect(
    (await app.dispatch({ ...command, commandId: crypto.randomUUID() })).ok,
  ).toBe(false);
});
it('rejects altered command identities and foreign or missing resource references', async () => {
  const app = setup();
  const created = await create(app);
  const changed = await app.dispatch({
    ...created.command,
    initialMessage: { text: 'Changed' },
  });
  expect(!changed.ok && changed.error.code).toBe('COMMAND_ID_REUSED');
  const missing = await app.dispatch({
    type: 'chat.get',
    commandId: crypto.randomUUID(),
    chatId: crypto.randomUUID(),
  });
  expect(!missing.ok && missing.error.status).toBe(404);
  app.grant.accountId = 'other-account';
  const foreign = await app.dispatch({
    type: 'chat.get',
    commandId: crypto.randomUUID(),
    chatId: created.id,
  });
  expect(!foreign.ok && foreign.error.status).toBe(404);
  const list = await app.dispatch({
    type: 'chat.list',
    commandId: crypto.randomUUID(),
  });
  expect(list.ok && list.data.chats).toEqual([]);
});
it('fences revocation while attachment preparation is pending', async () => {
  let finish: (() => void) | undefined;
  const engine = {
    prepareAttachments: () =>
      new Promise((resolve) => {
        finish = () => resolve([]);
      }),
  } as unknown as ManagerEngine;
  const app = setup(engine);
  // The cached read adapter only needs an engine service for snapshot operations.
  const created = await create(app);
  const uploadId = crypto.randomUUID();
  app.authorization.claim('upload', uploadId, app.grant.accountId);
  const sending = app.dispatch({
    type: 'conversation.message.send',
    commandId: crypto.randomUUID(),
    chatId: created.id,
    text: 'Should not be accepted',
    uploadIds: [uploadId],
  });
  await expect.poll(() => finish !== undefined).toBe(true);
  app.authorization.revoke(app.grant.sessionId);
  finish!();
  const result = await sending;
  expect(!result.ok && result.error.status).toBe(401);
  expect(app.store.pending(created.id)).toHaveLength(1);
});
it('blocks foreign-account command IDs before the domain cached-result boundary', async () => {
  let commands = 0;
  const engine = {
    wake: () => Promise.resolve(),
    service: {
      command: (command: { commandId: string }) => {
        commands += 1;
        return Promise.resolve({
          type: 'command.result',
          commandId: command.commandId,
          ok: true,
          data: { messageId: 'owner-only-data' },
        });
      },
    },
  } as unknown as ManagerEngine;
  const app = setup(engine);
  const owner = await create(app);
  const commandId = crypto.randomUUID();
  expect(
    (
      await app.dispatch({
        type: 'conversation.message.read',
        commandId,
        chatId: owner.id,
      })
    ).ok,
  ).toBe(true);
  app.grant.accountId = 'other-account';
  const other = await create(app);
  const attack = await app.dispatch({
    type: 'conversation.message.read',
    commandId,
    chatId: other.id,
  });
  expect(!attack.ok && attack.error.status).toBe(404);
  expect(commands).toBe(0);
});
it('sizes recent history by viewport while preserving long complete replies', () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    id: `${index}`,
    role: 'assistant' as const,
    text: 'A short reply',
    createdAt: index,
  }));
  const viewport = { width: 400, height: 300, fontSize: 16, lineHeight: 24 };
  expect(
    recentMessages(messages, { ...viewport, height: 900 }).length,
  ).toBeGreaterThan(recentMessages(messages, viewport).length);
  const text = 'Complete long answer '.repeat(20_000);
  const long = [
    ...messages,
    { id: 'long', role: 'assistant' as const, text, createdAt: 101 },
  ];
  expect(recentMessages(long, viewport)).toEqual([long.at(-1)]);
});

it('restores canonical rename values for engine execution and replays safe metadata without waking', async () => {
  const wake = vi.fn(() => Promise.resolve());
  const handle = vi.fn((command: ManagerCommand) => {
    if (command.type !== 'chat.rename') return Promise.resolve(undefined);
    const chat = {
      ...app.store.getChat(command.chatId),
      name: command.name,
      version: command.version + 1,
    };
    app.store.saveChat(chat);
    return Promise.resolve({ chat });
  });
  const boundary = new BrowserBoundary(() => ({
    documentsRoots: [],
    publications: [],
  }));
  const app = setup({ wake, handle } as unknown as ManagerEngine, boundary);
  const created = await create(app);
  const name = 'Review /recovery/private/team.txt';
  app.store.saveChat({ ...app.store.getChat(created.id), name });
  const command = {
    type: 'chat.rename',
    commandId: crypto.randomUUID(),
    chatId: created.id,
    version: 1,
    name: boundary.project(name),
  };
  const first = await app.dispatch(command);
  expect(first.ok).toBe(true);
  expect(handle).toHaveBeenCalledExactlyOnceWith({ ...command, name }, 'owner');
  expect(app.store.getChat(created.id).name).toBe(name);
  expect(first.ok && first.data.chat?.name).toBe(boundary.project(name));
  app.store.saveChat({ ...app.store.getChat(created.id), name: 'Later name' });
  wake.mockClear();
  expect(await app.dispatch(command)).toEqual(first);
  expect(handle).toHaveBeenCalledTimes(1);
  expect(wake).not.toHaveBeenCalled();
  expect(app.store.getChat(created.id).name).toBe('Later name');
  const altered = await app.dispatch({
    ...command,
    name: 'Changed command values',
  });
  expect(!altered.ok && altered.error.code).toBe('COMMAND_ID_REUSED');
});
