import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ConversationEvent } from '@messenger/contracts';
import { Store } from '../src/database.js';
import { ChatService, mapping } from '../src/chats/service.js';
import { FakeGateway, testSettings } from './fake-gateway.js';
import { settingsSchema } from '../src/schemas.js';

const resources: { store: Store; service: ChatService }[] = [];
afterEach(async () => {
  for (const { store, service } of resources.splice(0)) {
    service.close();
    await service.drain();
    store.close();
  }
});
async function fixture(count = 1) {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway);
  resources.push({ store, service });
  const chats = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      service.create({
        commandId: randomUUID(),
        name: `Chat ${i}`,
        settings: testSettings,
      }),
    ),
  );
  await service.drain();
  const inputs = chats.map((chat, i) => ({
    type: 'conversation.message.send' as const,
    commandId: randomUUID(),
    chatId: chat.id,
    text: `Own input ${i}`,
  }));
  await Promise.all(inputs.map((input) => service.command(input)));
  await service.drain();
  const targets = chats.map((chat) => mapping(store.getChat(chat.id)));
  for (const [i, target] of targets.entries()) {
    const history = gateway.histories.get(target.sessionKey);
    if (!history) throw new Error('Missing history');
    history.messages.push({
      id: randomUUID(),
      role: 'assistant',
      text: `Own reply ${i}`,
      createdAt: Date.now(),
      runId: inputs[i]?.commandId,
    });
  }
  return { store, gateway, service, chats, inputs, targets };
}

describe('terminal run history fences', () => {
  it('retains an unknown outcome without terminal evidence and blocks later accepted work', async () => {
    const f = await fixture();
    const chat = f.chats[0];
    const target = f.targets[0];
    const input = f.inputs[0];
    if (!chat || !target || !input) throw new Error('Missing fixture');
    const history = f.gateway.histories.get(target.sessionKey);
    if (!history) throw new Error('Missing history');
    history.activeRun = null;
    history.receipts = [];
    await f.service.reconcile();
    const next = randomUUID();
    await f.service.command({
      type: 'conversation.message.send',
      commandId: next,
      chatId: chat.id,
      text: 'Retained behind ambiguity',
    });
    await f.service.drain();
    const snapshot = await f.service.snapshot(chat.id);
    expect(snapshot.chat.status).toBe('recovery');
    expect(snapshot.activeRun).toBeNull();
    expect(
      snapshot.pending.map((item) => ({ id: item.id, state: item.state })),
    ).toEqual([
      { id: input.commandId, state: 'unknown' },
      { id: next, state: 'pending' },
    ]);
    expect(f.gateway.sends).toHaveLength(1);
  });
  it('keeps all ten finished chats idle when their terminal history briefly exposes the same empty sequence-zero run', async () => {
    const f = await fixture(10);
    const stale = new Map(
      f.targets.map((target, i) => [target.sessionKey, f.inputs[i]?.commandId]),
    );
    const original = f.gateway.history.bind(f.gateway);
    vi.spyOn(f.gateway, 'history').mockImplementation(async (...args) => {
      const history = structuredClone(await original(...args));
      const runId = stale.get(args[0].sessionKey);
      stale.delete(args[0].sessionKey);
      return runId
        ? { ...history, activeRun: { id: runId, text: '', sequence: 0 } }
        : history;
    });
    const frames: ConversationEvent[] = [];
    f.service.onEvent((event) => frames.push(event));
    for (const [i, target] of f.targets.entries()) {
      const input = f.inputs[i];
      if (!input) throw new Error('Missing input');
      f.gateway.complete(target, input.commandId, 11);
    }
    await vi.waitFor(() => expect(stale.size).toBe(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const chat of f.chats) {
      const snapshot = await f.service.snapshot(chat.id);
      expect(snapshot.chat.status).toBe('idle');
      expect(snapshot.activeRun).toBeNull();
      expect(snapshot.pending).toEqual([]);
      expect(snapshot.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
      ]);
      expect(
        frames
          .filter(
            (event) =>
              event.type === 'conversation.snapshot' &&
              event.snapshot.chat.id === chat.id,
          )
          .every(
            (event) =>
              event.type === 'conversation.snapshot' &&
              event.snapshot.activeRun === null,
          ),
      ).toBe(true);
    }
    expect(f.gateway.sends).toHaveLength(10);
  });

  it('dispatches the next retained input exactly once instead of blocking behind a resurrected terminal run', async () => {
    const f = await fixture();
    const chat = f.chats[0];
    const target = f.targets[0];
    const input = f.inputs[0];
    if (!chat || !target || !input) throw new Error('Missing fixture');
    const next = randomUUID();
    await f.service.command({
      type: 'conversation.message.send',
      commandId: next,
      chatId: chat.id,
      text: 'Accepted next input',
    });
    const original = f.gateway.history.bind(f.gateway);
    vi.spyOn(f.gateway, 'history').mockImplementationOnce(async (...args) => ({
      ...structuredClone(await original(...args)),
      activeRun: { id: input.commandId, text: '', sequence: 0 },
    }));
    f.gateway.complete(target, input.commandId, 11);
    await vi.waitFor(() =>
      expect(f.gateway.sends.map((send) => send.id)).toEqual([
        input.commandId,
        next,
      ]),
    );
    const snapshot = await f.service.snapshot(chat.id);
    expect(snapshot.activeRun?.id).toBe(next);
    expect(snapshot.chat.status).toBe('running');
    expect(snapshot.pending.map((item) => item.id)).toEqual([next]);
  });

  it('still adopts a different native run exposed by terminal history', async () => {
    const f = await fixture();
    const chat = f.chats[0];
    const target = f.targets[0];
    const input = f.inputs[0];
    if (!chat || !target || !input) throw new Error('Missing fixture');
    const newerRun = randomUUID();
    const original = f.gateway.history.bind(f.gateway);
    vi.spyOn(f.gateway, 'history').mockImplementationOnce(async (...args) => ({
      ...structuredClone(await original(...args)),
      activeRun: { id: newerRun, text: 'Different live run', sequence: 3 },
    }));
    f.gateway.complete(target, input.commandId, 11);
    await vi.waitFor(() =>
      expect(f.store.getChat(chat.id).status).toBe('running'),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await f.service.snapshot(chat.id)).activeRun).toMatchObject({
      id: newerRun,
      text: 'Different live run',
      sequence: 3,
    });
    expect(f.store.pending(chat.id)).toEqual([]);
    expect(f.gateway.sends).toHaveLength(1);
  });

  it('does not resurrect an already terminal run from an abort read-back', async () => {
    const f = await fixture();
    const chat = f.chats[0];
    const target = f.targets[0];
    const input = f.inputs[0];
    if (!chat || !target || !input) throw new Error('Missing fixture');
    f.gateway.complete(target, input.commandId, 11);
    await vi.waitFor(() => expect(f.store.pending(chat.id)).toEqual([]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const original = f.gateway.history.bind(f.gateway);
    vi.spyOn(f.gateway, 'history').mockImplementationOnce(async (...args) => ({
      ...structuredClone(await original(...args)),
      activeRun: { id: input.commandId, text: '', sequence: 0 },
    }));
    expect(
      await f.service.command({
        type: 'conversation.run.abort',
        commandId: randomUUID(),
        chatId: chat.id,
      }),
    ).toMatchObject({ ok: true });
    const snapshot = await f.service.snapshot(chat.id);
    expect(snapshot.chat.status).toBe('idle');
    expect(snapshot.activeRun).toBeNull();
    expect(f.gateway.sends).toHaveLength(1);
  });
  it('does not block cancel-work settings on a terminal run still exposed by history', async () => {
    const f = await fixture();
    const chat = f.chats[0];
    const target = f.targets[0];
    const input = f.inputs[0];
    if (!chat || !target || !input) throw new Error('Missing fixture');
    f.gateway.complete(target, input.commandId, 11);
    await vi.waitFor(() => expect(f.store.pending(chat.id)).toEqual([]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const original = f.gateway.history.bind(f.gateway);
    vi.spyOn(f.gateway, 'history').mockImplementationOnce(async (...args) => ({
      ...structuredClone(await original(...args)),
      activeRun: { id: input.commandId, text: '', sequence: 0 },
    }));
    const desired = { ...testSettings, fastMode: true };
    await f.service.updateSettings(
      chat.id,
      desired,
      'cancel-work',
      `"${f.store.getChat(chat.id).version}"`,
    );
    await f.service.drain();
    expect(f.store.getChat(chat.id).settings).toEqual(
      settingsSchema.parse(desired),
    );
    expect(f.store.settingsOperation(chat.id)).toBeNull();
    expect((await f.service.snapshot(chat.id)).activeRun).toBeNull();
    expect(f.gateway.sends).toHaveLength(1);
  });
});
