import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationCommand } from '@messenger/contracts';
import { Store } from '../src/database.js';
import { ChatService, mapping } from '../src/chats/service.js';
import { historyWithReceipts } from '../src/chats/history.js';
import {
  FakeGateway,
  normalizedTestSettings,
  testSettings,
} from './fake-gateway.js';
import { settingsSchema } from '../src/schemas.js';

const services: ChatService[] = [];
const stores = new Set<Store>();
afterEach(async () => {
  for (const service of services.splice(0)) {
    service.close();
    await service.drain();
  }
  for (const store of stores) store.close();
  stores.clear();
});
async function fixture(path = ':memory:', gateway = new FakeGateway()) {
  const store = new Store(path);
  stores.add(store);
  const service = new ChatService(store, gateway);
  services.push(service);
  const chat = await service.create({
    commandId: randomUUID(),
    settings: testSettings,
  });
  await service.drain();
  return {
    store,
    service,
    gateway,
    chat,
    target: mapping(store.getChat(chat.id)),
  };
}
function send(
  chatId: string,
  text: string,
): Extract<ConversationCommand, { type: 'conversation.message.send' }> {
  return {
    type: 'conversation.message.send',
    commandId: randomUUID(),
    chatId,
    text,
  };
}
function action(
  chatId: string,
  messageId: string,
  revision: number,
  type:
    'conversation.message.cancelQueued' | 'conversation.message.steerQueued',
): ConversationCommand {
  return { type, commandId: randomUUID(), chatId, messageId, revision };
}

describe('durable backend queue and dispatcher', () => {
  it('accepts twenty offline messages without Gateway submission, preserves edited positions, enforces revisions and never evicts', async () => {
    const f = await fixture();
    f.gateway.ready = false;
    const commands = Array.from({ length: 20 }, (_, i) =>
      send(f.chat.id, `message ${i}`),
    );
    const accepted = await Promise.all(
      commands.map((command) => f.service.command(command)),
    );
    expect(accepted.every((result) => result.ok)).toBe(true);
    expect(f.gateway.sends).toHaveLength(0);
    const queue = f.service.pending(f.chat.id);
    const item = queue[4];
    if (!item) throw new Error('Missing item');
    const edit = {
      type: 'conversation.message.editQueued' as const,
      commandId: randomUUID(),
      chatId: f.chat.id,
      messageId: item.id,
      revision: 1,
      text: 'corrected',
    };
    expect((await f.service.command(edit)).ok).toBe(true);
    expect(f.service.pending(f.chat.id).map((entry) => entry.id)).toEqual(
      queue.map((entry) => entry.id),
    );
    expect(f.service.pending(f.chat.id)[4]).toMatchObject({
      text: 'corrected',
      position: item.position,
      revision: 2,
    });
    expect(
      await f.service.command({ ...edit, commandId: randomUUID() }),
    ).toMatchObject({ ok: false, error: { code: 'STALE_MESSAGE' } });
    expect(await f.service.command(send(f.chat.id, 'overflow'))).toMatchObject({
      ok: false,
      error: { code: 'QUEUE_FULL' },
    });
    expect(f.service.pending(f.chat.id)).toHaveLength(20);
    expect((await f.service.snapshot(f.chat.id)).pending).toHaveLength(20);
  });
  it('restores SQLite order across backend restart and dispatches exactly the earliest corrected input', async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'messenger-queue-')),
      'state.sqlite',
    );
    const f = await fixture(path);
    f.gateway.ready = false;
    await f.service.command(send(f.chat.id, 'first'));
    await f.service.command(send(f.chat.id, 'second'));
    const item = f.service.pending(f.chat.id)[0];
    if (!item) throw new Error('Missing item');
    await f.service.command({
      type: 'conversation.message.editQueued',
      commandId: randomUUID(),
      chatId: f.chat.id,
      messageId: item.id,
      revision: 1,
      text: 'first corrected',
    });
    f.service.close();
    await f.service.drain();
    f.store.close();
    stores.delete(f.store);
    const store = new Store(path);
    stores.add(store);
    const service = new ChatService(store, f.gateway);
    services.push(service);
    f.gateway.ready = true;
    await service.reconcile();
    await service.drain();
    expect(f.gateway.sends.map((entry) => entry.text)).toEqual([
      'first corrected',
    ]);
    expect(service.pending(f.chat.id).map((entry) => entry.text)).toEqual([
      'first corrected',
      'second',
    ]);
    f.gateway.complete(f.target, item.submissionId);
    await vi.waitFor(() =>
      expect(f.gateway.sends.map((entry) => entry.text)).toEqual([
        'first corrected',
        'second',
      ]),
    );
  });
  it('fences edit and cancel after claim while a send is in flight, and persists acceptance before waiting on Gateway', async () => {
    const f = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.gateway.send.bind(f.gateway);
    vi.spyOn(f.gateway, 'send').mockImplementation(async (...args) => {
      await blocked;
      return original(...args);
    });
    const command = send(f.chat.id, 'in flight');
    expect((await f.service.command(command)).ok).toBe(true);
    await vi.waitFor(() =>
      expect(f.service.pending(f.chat.id)[0]?.state).toBe('submitting'),
    );
    expect(
      await f.service.command({
        type: 'conversation.message.editQueued',
        commandId: randomUUID(),
        chatId: f.chat.id,
        messageId: command.commandId,
        revision: 1,
        text: 'racing correction',
      }),
    ).toMatchObject({ ok: false, error: { code: 'MESSAGE_CLAIMED' } });
    expect(
      await f.service.command(
        action(
          f.chat.id,
          command.commandId,
          1,
          'conversation.message.cancelQueued',
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'MESSAGE_CLAIMED' } });
    release();
    await f.service.drain();
    expect(f.gateway.sends).toHaveLength(1);
  });
  it('runs ten chats independently and reserves no eleventh slot under concurrent creation', async () => {
    const store = new Store(':memory:');
    stores.add(store);
    const gateway = new FakeGateway();
    const service = new ChatService(store, gateway);
    services.push(service);
    const created = await Promise.allSettled(
      Array.from({ length: 11 }, () =>
        service.create({ commandId: randomUUID(), settings: testSettings }),
      ),
    );
    expect(
      created.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(10);
    const chats = store.listChats();
    await Promise.all(
      chats.map((chat) => service.command(send(chat.id, chat.id))),
    );
    await service.drain();
    expect(gateway.sends).toHaveLength(10);
    expect(
      new Set(gateway.sends.map((item) => item.mapping.sessionKey)).size,
    ).toBe(10);
    const first = chats[0];
    if (!first) throw new Error('Missing chat');
    await service.command(send(first.id, 'queued'));
    gateway.complete(mapping(first), gateway.sends[0]?.id ?? '');
    await vi.waitFor(() => expect(gateway.sends).toHaveLength(11));
    expect(
      store.listChats().filter((chat) => chat.status === 'running'),
    ).toHaveLength(10);
  });
  it('cancels only the selected unsent item and steering changes ownership after acceptance', async () => {
    const f = await fixture();
    const active = send(f.chat.id, 'active');
    await f.service.command(active);
    await f.service.drain();
    const first = send(f.chat.id, 'cancel');
    const second = send(f.chat.id, 'steer');
    await f.service.command(first);
    await f.service.command(second);
    expect(
      (
        await f.service.command(
          action(
            f.chat.id,
            first.commandId,
            1,
            'conversation.message.cancelQueued',
          ),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await f.service.command(
          action(
            f.chat.id,
            second.commandId,
            1,
            'conversation.message.steerQueued',
          ),
        )
      ).ok,
    ).toBe(true);
    await vi.waitFor(() =>
      expect(
        f.service
          .pending(f.chat.id)
          .find((item) => item.id === second.commandId)?.state,
      ).toBe('submitted'),
    );
    expect(f.gateway.sends.map((item) => item.text)).toEqual([
      'active',
      'steer',
    ]);
    expect(
      f.service.pending(f.chat.id).some((item) => item.id === first.commandId),
    ).toBe(false);
  });
  it('deduplicates concurrent command IDs globally and rejects reuse with changed content or chat', async () => {
    const f = await fixture();
    const other = await f.service.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    f.gateway.ready = false;
    const command = send(f.chat.id, 'same');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => f.service.command(command)),
    );
    expect(
      results.every(
        (result) => JSON.stringify(result) === JSON.stringify(results[0]),
      ),
    ).toBe(true);
    expect(f.service.pending(f.chat.id)).toHaveLength(1);
    expect(
      await f.service.command({ ...command, chatId: other.id }),
    ).toMatchObject({ ok: false, error: { code: 'COMMAND_ID_REUSED' } });
    expect(
      await f.service.command({ ...command, text: 'changed' }),
    ).toMatchObject({ ok: false, error: { code: 'COMMAND_ID_REUSED' } });
  });
});

describe('receipt reconciliation and lifecycle operations', () => {
  it('adopts accepted sends with lost ACK and never automatically replays unknown, consumed or cancelled inputs', async () => {
    const f = await fixture();
    f.gateway.acceptThenFail = true;
    const command = send(f.chat.id, 'lost ACK');
    await f.service.command(command);
    await f.service.drain();
    expect(f.service.pending(f.chat.id)[0]?.state).toBe('unknown');
    f.gateway.acceptThenFail = false;
    await f.service.reconcile();
    await f.service.drain();
    expect(f.service.pending(f.chat.id)[0]?.state).toBe('submitted');
    expect(f.gateway.sends).toHaveLength(1);
    const history = f.gateway.histories.get(f.target.sessionKey);
    if (!history) throw new Error('Missing history');
    history.activeRun = null;
    const receipt = history.receipts[0];
    if (!receipt) throw new Error('Missing receipt');
    receipt.state = 'consumed';
    await f.service.reconcile();
    await f.service.drain();
    expect(f.service.pending(f.chat.id)).toHaveLength(0);
    expect(f.gateway.sends).toHaveLength(1);
    f.gateway.failSend = true;
    const unknown = send(f.chat.id, 'uncertain');
    await f.service.command(unknown);
    await f.service.drain();
    f.gateway.failSend = false;
    await f.service.reconcile();
    await f.service.drain();
    expect(f.service.pending(f.chat.id)[0]?.state).toBe('unknown');
    expect(f.gateway.sends).toHaveLength(2);
    history.receipts.push({
      runId: unknown.commandId,
      state: 'pending',
      cancelled: true,
    });
    await f.service.reconcile();
    await f.service.drain();
    expect(f.service.pending(f.chat.id)).toHaveLength(0);
    expect(f.gateway.sends).toHaveLength(2);
  });
  it('requires explicit recovery and checks the original session scope before retry with the same submission identity', async () => {
    const f = await fixture();
    f.gateway.failSend = true;
    const command = send(f.chat.id, 'retained');
    await f.service.command(command);
    await f.service.drain();
    f.gateway.failSend = false;
    const recovery = {
      type: 'conversation.message.resolveUnknown' as const,
      commandId: randomUUID(),
      chatId: f.chat.id,
      messageId: command.commandId,
      revision: 1,
      action: 'retry' as const,
    };
    expect((await f.service.command(recovery)).ok).toBe(true);
    await f.service.drain();
    expect(f.gateway.sends.map((item) => item.id)).toEqual([
      command.commandId,
      command.commandId,
    ]);
    f.gateway.complete(f.target, command.commandId);
    await vi.waitFor(() =>
      expect(f.service.pending(f.chat.id)).toHaveLength(0),
    );
    f.gateway.failSend = true;
    const changed = send(f.chat.id, 'session replaced');
    await f.service.command(changed);
    await f.service.drain();
    const history = f.gateway.histories.get(f.target.sessionKey);
    if (!history) throw new Error('Missing history');
    history.sessionId = 'new-session';
    history.activeRun = null;
    expect(
      await f.service.command({
        ...recovery,
        commandId: randomUUID(),
        messageId: changed.commandId,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'RECOVERY_REQUIRES_NEW_SUBMISSION' },
    });
    expect(f.service.pending(f.chat.id)[0]?.text).toBe('session replaced');
  });
  it('adopts creation after a lost ACK, retains initial message and preserves manual naming', async () => {
    const f = await fixture();
    f.gateway.createThenFail = true;
    const commandId = randomUUID();
    await expect(
      f.service.create({
        commandId,
        settings: testSettings,
        initialMessage: { text: 'first title' },
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
    const created = f.store.findCreation(commandId);
    if (!created) throw new Error('Missing reservation');
    expect(f.service.pending(created.id)[0]?.text).toBe('first title');
    await f.service.rename(created.id, 'Manual title', `"${created.version}"`);
    f.gateway.createThenFail = false;
    await f.service.reconcile();
    await f.service.drain();
    expect(f.store.getChat(created.id).name).toBe('Manual title');
    expect(
      f.gateway.sends.filter(
        (item) =>
          item.mapping.sessionKey ===
          mapping(f.store.getChat(created.id)).sessionKey,
      ),
    ).toHaveLength(1);
  });
  it('holds a deletion reservation through a lost ACK then frees it after authoritative absence without replaying work', async () => {
    const f = await fixture();
    await f.service.command(send(f.chat.id, 'active'));
    await f.service.drain();
    const other = await f.service.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    f.gateway.failRemove = true;
    await f.service.delete(
      f.chat.id,
      `"${f.store.getChat(f.chat.id).version}"`,
    );
    await f.service.drain();
    expect(f.store.getChat(f.chat.id).status).toBe('deleting');
    expect(await f.service.command(send(f.chat.id, 'fenced'))).toMatchObject({
      ok: false,
      error: { code: 'CHAT_UNAVAILABLE' },
    });
    f.gateway.failRemove = false;
    await f.service.reconcile();
    await f.service.drain();
    expect(() => f.store.getChat(f.chat.id)).toThrow();
    expect(f.store.getChat(other.id).status).toBe('idle');
    expect(f.gateway.sends).toHaveLength(1);
  });
});

describe('settings and titles', () => {
  it('uses the own-agent Gateway title operation and ignores a late result after manual rename', async () => {
    const f = await fixture();
    let release!: (title: string) => void;
    const title = new Promise<string>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(f.gateway, 'title').mockReturnValue(title);
    await f.service.command(send(f.chat.id, 'Title seed'));
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        f.target,
        testSettings.model,
        'Title seed',
      ),
    );
    await f.service.rename(
      f.chat.id,
      'Manual name',
      `"${f.store.getChat(f.chat.id).version}"`,
    );
    release('Late automatic name');
    await f.service.drain();
    expect(f.store.getChat(f.chat.id).name).toBe('Manual name');
    expect(spy).toHaveBeenCalledTimes(1);
    const other = await f.service.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    spy.mockResolvedValue('Prepared own-agent title');
    await f.service.command(send(other.id, 'Other seed'));
    await f.service.drain();
    expect(f.store.getChat(other.id).name).toBe('Prepared own-agent title');
  });
  it('defers settings until active and ordered queued work is complete, restores pending state and rejects conflicting saves', async () => {
    const f = await fixture();
    const first = send(f.chat.id, 'first');
    const second = send(f.chat.id, 'second');
    await f.service.command(first);
    await f.service.drain();
    await f.service.command(second);
    const desired = { ...testSettings, thinkingLevel: 'high', fastMode: true };
    await f.service.updateSettings(
      f.chat.id,
      desired,
      'when-idle',
      `"${f.store.getChat(f.chat.id).version}"`,
    );
    await f.service.drain();
    expect((await f.service.snapshot(f.chat.id)).pendingSettings?.status).toBe(
      'pending',
    );
    expect(f.store.getChat(f.chat.id).settings).toEqual(normalizedTestSettings);
    await expect(
      f.service.updateSettings(
        f.chat.id,
        testSettings,
        'when-idle',
        `"${f.store.getChat(f.chat.id).version}"`,
      ),
    ).rejects.toMatchObject({ code: 'SETTINGS_PENDING' });
    f.gateway.complete(f.target, first.commandId);
    await vi.waitFor(() => expect(f.gateway.sends).toHaveLength(2));
    f.gateway.complete(f.target, second.commandId);
    await vi.waitFor(() =>
      expect(f.store.settingsOperation(f.chat.id)).toBeNull(),
    );
    expect(f.store.getChat(f.chat.id).settings).toEqual(
      settingsSchema.parse(desired),
    );
  });
  it('guards a cancel-work settings transition and leaves the other chat untouched', async () => {
    const f = await fixture();
    const other = await f.service.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    await f.service.command(send(f.chat.id, 'active'));
    await f.service.drain();
    await f.service.command(send(f.chat.id, 'cancel queued'));
    let release!: () => void;
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.gateway.settings.bind(f.gateway);
    vi.spyOn(f.gateway, 'settings').mockImplementation(async (...args) => {
      await latch;
      return original(...args);
    });
    const desired = { ...testSettings, fastMode: true };
    await f.service.updateSettings(
      f.chat.id,
      desired,
      'cancel-work',
      `"${f.store.getChat(f.chat.id).version}"`,
    );
    await vi.waitFor(() =>
      expect(f.store.settingsOperation(f.chat.id)?.status).toBe('applying'),
    );
    expect(await f.service.command(send(f.chat.id, 'racing'))).toMatchObject({
      ok: false,
      error: { code: 'SETTINGS_APPLYING' },
    });
    expect((await f.service.command(send(other.id, 'independent'))).ok).toBe(
      true,
    );
    release();
    await f.service.drain();
    expect(f.service.pending(f.chat.id)).toHaveLength(0);
    expect(f.store.getChat(f.chat.id).settings).toEqual(
      settingsSchema.parse(desired),
    );
    expect(f.store.getChat(other.id).settings).toEqual(normalizedTestSettings);
  });
  it('reads back unknown settings after restart reconciliation instead of patching twice', async () => {
    const f = await fixture();
    f.gateway.failSettings = true;
    const desired = { ...testSettings, thinkingLevel: 'high' };
    const spy = vi.spyOn(f.gateway, 'settings');
    await f.service.updateSettings(
      f.chat.id,
      desired,
      'when-idle',
      `"${f.store.getChat(f.chat.id).version}"`,
    );
    await f.service.drain();
    expect(f.store.settingsOperation(f.chat.id)?.status).toBe('unknown');
    f.gateway.failSettings = false;
    await f.service.reconcile();
    await f.service.drain();
    expect(f.store.settingsOperation(f.chat.id)).toBeNull();
    expect(f.store.getChat(f.chat.id).settings).toEqual(
      settingsSchema.parse(desired),
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('uses deterministic title fallback and permanently prioritizes manual rename', async () => {
    const f = await fixture();
    f.gateway.ready = false;
    await f.service.command(send(f.chat.id, '  A useful\n  title  '));
    expect(f.store.getChat(f.chat.id).name).toBe('A useful title');
    await f.service.rename(
      f.chat.id,
      'New chat',
      `"${f.store.getChat(f.chat.id).version}"`,
    );
    await f.service.command(send(f.chat.id, 'Must not overwrite'));
    expect(f.store.getChat(f.chat.id).name).toBe('New chat');
  });
});

describe('recovery and snapshot race regressions', () => {
  it('publishes completed canonical history when marking a visible chat read during terminal reconciliation', async () => {
    const f = await fixture();
    const command = send(f.chat.id, 'accepted initial question');
    await f.service.command(command);
    await f.service.drain();
    const history = f.gateway.histories.get(f.target.sessionKey);
    if (!history) throw new Error('Missing history');
    history.messages.push({
      id: 'completed-reply',
      role: 'assistant',
      text: 'completed canonical reply',
      createdAt: Date.now(),
    });
    let release!: () => void;
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.gateway.history.bind(f.gateway);
    const read = vi
      .spyOn(f.gateway, 'history')
      .mockImplementationOnce(async (...args) => {
        const result = structuredClone(await original(...args));
        await latch;
        return result;
      });
    const snapshots: string[][] = [];
    f.service.onEvent((event) => {
      if (event.type === 'conversation.snapshot')
        snapshots.push(event.snapshot.messages.map((message) => message.text));
    });
    f.gateway.complete(f.target, command.commandId);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await f.service.command({
      type: 'conversation.message.read',
      commandId: randomUUID(),
      chatId: f.chat.id,
    });
    await f.service.rename(
      f.chat.id,
      'Renamed while history loads',
      `"${f.store.getChat(f.chat.id).version}"`,
    );
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.gateway.ready = false;
    expect(
      (await f.service.snapshot(f.chat.id)).messages.map(
        (message) => message.text,
      ),
    ).toContain('completed canonical reply');
    expect(
      snapshots.some((messages) =>
        messages.includes('completed canonical reply'),
      ),
    ).toBe(true);
    expect(f.store.getChat(f.chat.id).unread).toBe(false);
    expect(f.store.getChat(f.chat.id).name).toBe('Renamed while history loads');
  });
  it('preserves canonical terminal history when an own-agent title arrives during reconciliation', async () => {
    const f = await fixture();
    await f.service.reconcile();
    let finishTitle!: (title: string) => void;
    const title = new Promise<string>((resolve) => {
      finishTitle = resolve;
    });
    vi.spyOn(f.gateway, 'title').mockReturnValueOnce(title);
    const command = send(f.chat.id, 'title seed');
    await f.service.command(command);
    await vi.waitFor(() =>
      expect(f.service.pending(f.chat.id)[0]?.state).toBe('submitted'),
    );
    const history = f.gateway.histories.get(f.target.sessionKey);
    if (!history) throw new Error('Missing history');
    history.messages.push({
      id: 'title-reply',
      role: 'assistant',
      text: 'reply retained with late title',
      createdAt: Date.now(),
    });
    let finishHistory!: () => void;
    const latch = new Promise<void>((resolve) => {
      finishHistory = resolve;
    });
    const original = f.gateway.history.bind(f.gateway);
    const read = vi
      .spyOn(f.gateway, 'history')
      .mockImplementationOnce(async (...args) => {
        const result = structuredClone(await original(...args));
        await latch;
        return result;
      });
    f.gateway.complete(f.target, command.commandId);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    finishTitle('Own agent generated title');
    await vi.waitFor(() =>
      expect(f.store.getChat(f.chat.id).name).toBe('Own agent generated title'),
    );
    finishHistory();
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.gateway.ready = false;
    expect(
      (await f.service.snapshot(f.chat.id)).messages.map(
        (message) => message.text,
      ),
    ).toContain('reply retained with late title');
  });
  it('retries terminal reconciliation superseded by a newer failed snapshot read', async () => {
    const f = await fixture();
    await f.service.reconcile();
    const command = send(f.chat.id, 'initial question');
    await f.service.command(command);
    await f.service.drain();
    const history = f.gateway.histories.get(f.target.sessionKey);
    if (!history) throw new Error('Missing history');
    history.messages.push({
      id: 'retry-reply',
      role: 'assistant',
      text: 'reply retained after newer read failed',
      createdAt: Date.now(),
    });
    let release!: () => void;
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.gateway.history.bind(f.gateway);
    const read = vi
      .spyOn(f.gateway, 'history')
      .mockImplementationOnce(async (...args) => {
        const result = structuredClone(await original(...args));
        await latch;
        return result;
      })
      .mockRejectedValueOnce(
        new Error('Newer snapshot temporarily unavailable'),
      );
    const replies: string[] = [];
    f.service.onEvent((event) => {
      if (event.type === 'conversation.snapshot')
        replies.push(
          ...event.snapshot.messages
            .filter((message) => message.role === 'assistant')
            .map((message) => message.text),
        );
    });
    f.gateway.complete(f.target, command.commandId);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await f.service.snapshot(f.chat.id);
    release();
    await vi.waitFor(
      () => expect(replies).toContain('reply retained after newer read failed'),
      { timeout: 3000 },
    );
    f.gateway.ready = false;
    expect(
      (await f.service.snapshot(f.chat.id)).messages.map(
        (message) => message.text,
      ),
    ).toContain('reply retained after newer read failed');
  });
  it('bounds each authoritative receipt lookup to the pinned fifty-ID limit without losing retained inputs', async () => {
    const f = await fixture();
    const history = f.gateway.histories.get(f.target.sessionKey);
    if (!history) throw new Error('Missing history');
    const ids = Array.from({ length: 121 }, () => randomUUID());
    history.receipts = ids.map((runId) => ({ runId, state: 'consumed' }));
    const spy = vi.spyOn(f.gateway, 'history');
    const result = await historyWithReceipts(f.gateway, f.target, ids);
    expect(spy.mock.calls.map((call) => call[1]?.inputRunIds?.length)).toEqual([
      50, 50, 21,
    ]);
    expect(result.receipts.map((receipt) => receipt.runId)).toEqual(ids);
  });
  it('rejects old replacement callbacks after authoritative reconnect stream readback', async () => {
    const f = await fixture();
    const command = send(f.chat.id, 'active');
    await f.service.command(command);
    await f.service.drain();
    const history = f.gateway.histories.get(f.target.sessionKey);
    if (!history) throw new Error('Missing history');
    history.activeRun = {
      id: command.commandId,
      text: 'authoritative stream',
      sequence: 20,
    };
    await f.service.reconcile();
    f.gateway.emit({
      type: 'chat',
      sessionKey: f.target.sessionKey,
      runId: command.commandId,
      sequence: 5,
      state: 'delta',
      text: 'old callback',
      replace: true,
    });
    expect((await f.service.snapshot(f.chat.id)).activeRun?.text).toBe(
      'authoritative stream',
    );
  });
  it('preserves a manual rename during an uncertain creation retry', async () => {
    const f = await fixture();
    f.gateway.failCreation = true;
    const input = { commandId: randomUUID(), settings: testSettings };
    await expect(f.service.create(input)).rejects.toMatchObject({
      code: 'GATEWAY_UNAVAILABLE',
    });
    const chat = f.store.findCreation(input.commandId);
    if (!chat) throw new Error('Missing creation');
    f.gateway.failCreation = false;
    let release!: () => void;
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = vi
      .spyOn(f.gateway, 'recoverCreation')
      .mockImplementationOnce(async () => {
        await latch;
        return null;
      });
    const retry = f.service.create(input);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
    await f.service.rename(
      chat.id,
      'Manual during recovery',
      `"${chat.version}"`,
    );
    release();
    await retry;
    await f.service.drain();
    expect(f.store.getChat(chat.id).name).toBe('Manual during recovery');
  });
  it('persistently acknowledges local enqueue before dispatch and reconstructs duplicates after loss of transport', async () => {
    const f = await fixture();
    f.gateway.ready = false;
    const command = send(f.chat.id, 'durable ACK');
    const accepted = await f.service.command(command);
    expect(f.store.getCommand(command.commandId)).toEqual(accepted);
    f.service.close();
    const restarted = new ChatService(f.store, f.gateway);
    services.push(restarted);
    expect(await restarted.command(command)).toEqual(accepted);
    expect(restarted.pending(f.chat.id)).toHaveLength(1);
    expect(f.gateway.sends).toHaveLength(0);
  });
  it('does not overwrite the final transcript with an older delayed snapshot', async () => {
    const f = await fixture();
    const command = send(f.chat.id, 'first');
    await f.service.command(command);
    await f.service.drain();
    const original = f.gateway.history.bind(f.gateway);
    const stale = structuredClone(await original(f.target));
    let release!: () => void;
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(f.gateway, 'history').mockImplementationOnce(async () => {
      await latch;
      return stale;
    });
    const oldSnapshot = f.service.snapshot(f.chat.id);
    const history = f.gateway.histories.get(f.target.sessionKey);
    if (!history) throw new Error('Missing history');
    history.messages.push({
      id: 'final',
      role: 'assistant',
      text: 'new final response',
      createdAt: Date.now(),
    });
    f.gateway.complete(f.target, command.commandId);
    await vi.waitFor(() =>
      expect(f.store.getChat(f.chat.id).status).toBe('idle'),
    );
    await vi.waitFor(async () =>
      expect(
        (await f.service.snapshot(f.chat.id)).messages.map(
          (message) => message.text,
        ),
      ).toContain('new final response'),
    );
    release();
    expect(
      (await oldSnapshot).messages.map((message) => message.text),
    ).toContain('new final response');
    f.gateway.ready = false;
    expect(
      (await f.service.snapshot(f.chat.id)).messages.map(
        (message) => message.text,
      ),
    ).toContain('new final response');
  });
  it('fences an older idle reconciliation read after newer acceptance', async () => {
    const f = await fixture();
    const original = f.gateway.history.bind(f.gateway);
    const stale = structuredClone(await original(f.target));
    let release!: () => void;
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(f.gateway, 'history').mockImplementationOnce(async () => {
      await latch;
      return stale;
    });
    const reconciliation = f.service.reconcile();
    await Promise.resolve();
    await f.service.command(send(f.chat.id, 'new accepted input'));
    await f.service.drain();
    release();
    await reconciliation;
    expect(f.store.getChat(f.chat.id).status).toBe('running');
    expect(f.service.pending(f.chat.id)[0]?.state).toBe('submitted');
    expect((await f.service.snapshot(f.chat.id)).activeRun).not.toBeNull();
  });
  it('dispatches the next input after a terminal read outage and restores readiness without reconnect', async () => {
    const f = await fixture();
    const first = send(f.chat.id, 'first');
    await f.service.command(first);
    await f.service.drain();
    await f.service.command(send(f.chat.id, 'second'));
    const states: string[] = [];
    f.service.onEvent((event) => {
      if (event.type === 'connection.state') states.push(event.state);
    });
    vi.spyOn(f.gateway, 'history').mockRejectedValueOnce(
      new Error('Transient unavailable'),
    );
    f.gateway.complete(f.target, first.commandId);
    await vi.waitFor(() => expect(f.gateway.sends).toHaveLength(2));
    await vi.waitFor(() => expect(f.service.reconciled).toBe(true), {
      timeout: 3000,
    });
    expect(states).toContain('unavailable');
    expect(states.at(-1)).toBe('ready');
  });
  it('keeps definitely unsent preflight failures pending and retries without requiring manual unknown recovery', async () => {
    const f = await fixture();
    vi.spyOn(f.gateway, 'history').mockRejectedValueOnce(
      new Error('Temporary pre-send read outage'),
    );
    await f.service.command(send(f.chat.id, 'not submitted yet'));
    await f.service.drain();
    expect(f.service.pending(f.chat.id)[0]?.state).toBe('pending');
    expect(f.gateway.sends).toHaveLength(0);
    await vi.waitFor(() => expect(f.gateway.sends).toHaveLength(1), {
      timeout: 3000,
    });
    expect(f.service.pending(f.chat.id)[0]?.state).toBe('submitted');
  });
  it('deletes an absent failed creation, rejects its stale command forever, and cleans a late agent through a read-only tombstone lookup', async () => {
    const f = await fixture();
    f.gateway.failCreation = true;
    const input = { commandId: randomUUID(), settings: testSettings };
    await expect(f.service.create(input)).rejects.toMatchObject({
      code: 'GATEWAY_UNAVAILABLE',
    });
    const chat = f.store.findCreation(input.commandId);
    if (!chat) throw new Error('Missing creation');
    await f.service.delete(chat.id, `"${chat.version}"`);
    await f.service.drain();
    expect(() => f.store.getChat(chat.id)).toThrow();
    await expect(f.service.create(input)).rejects.toMatchObject({
      code: 'CHAT_DELETED',
    });
    f.gateway.failCreation = false;
    const late = await f.gateway.create(chat.id, testSettings);
    const initialization = vi
      .spyOn(f.gateway, 'recoverCreation')
      .mockRejectedValue(new Error('Never initialize deleted agent'));
    await f.service.reconcile();
    await f.service.drain();
    expect(await f.gateway.exists(late)).toBe(false);
    expect(initialization).not.toHaveBeenCalled();
    expect(f.store.listChats()).toHaveLength(1);
  });
  it('isolates failed creation adoption so another chat can recover and dispatch', async () => {
    const f = await fixture();
    f.gateway.failCreation = true;
    await expect(
      f.service.create({ commandId: randomUUID(), settings: testSettings }),
    ).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
    f.gateway.failCreation = false;
    const healthy = await f.service.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    f.gateway.ready = false;
    await f.service.command(send(healthy.id, 'independent offline input'));
    f.gateway.ready = true;
    vi.spyOn(f.gateway, 'recoverCreation').mockRejectedValue(
      new Error('Incomplete agent has invalid settings'),
    );
    await f.service.reconcile();
    await f.service.drain();
    expect(
      f.gateway.sends.some(
        (entry) => entry.text === 'independent offline input',
      ),
    ).toBe(true);
    expect(f.service.reconciled).toBe(false);
  });
  it('retries unknown settings only after authoritative readback and explicit action', async () => {
    const f = await fixture();
    const original = f.gateway.settings.bind(f.gateway);
    const spy = vi
      .spyOn(f.gateway, 'settings')
      .mockRejectedValueOnce(new Error('Unknown patch outcome'));
    const desired = { ...testSettings, fastMode: true };
    await f.service.updateSettings(
      f.chat.id,
      desired,
      'when-idle',
      `"${f.store.getChat(f.chat.id).version}"`,
    );
    await f.service.drain();
    expect(f.store.settingsOperation(f.chat.id)?.status).toBe('unknown');
    await f.service.reconcile();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockImplementation(original);
    await f.service.resolveSettings(
      f.chat.id,
      'retry',
      `"${f.store.getChat(f.chat.id).version}"`,
    );
    await f.service.drain();
    expect(f.store.settingsOperation(f.chat.id)).toBeNull();
    expect(f.store.getChat(f.chat.id).settings).toEqual(
      settingsSchema.parse(desired),
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
