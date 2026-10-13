import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ConversationEvent, PendingMessage } from '@messenger/contracts';
import { Store } from '../src/database.js';
import { ChatService, mapping } from '../src/chats/service.js';
import { FakeGateway, testSettings } from './fake-gateway.js';

const resources: { store: Store; service: ChatService }[] = [];
afterEach(async () => {
  for (const { store, service } of resources.splice(0)) {
    service.close();
    await service.drain();
    store.close();
  }
});
async function fixture() {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway);
  resources.push({ store, service });
  const chat = await service.create({
    commandId: randomUUID(),
    settings: testSettings,
  });
  await service.drain();
  return {
    store,
    gateway,
    service,
    chat,
    target: mapping(store.getChat(chat.id)),
  };
}
const previewLimit = 256 * 1024;
function seed(
  store: Store,
  chatId: string,
  state: PendingMessage['state'],
  position: number,
): PendingMessage {
  const item: PendingMessage = {
    id: randomUUID(),
    chatId,
    position,
    text: 'retained input',
    attachments: [],
    revision: 1,
    state,
    submissionId: randomUUID(),
    createdAt: position,
  };
  store.savePending(item);
  return item;
}
describe('bounded conversation display projections', () => {
  it('preserves steering admission and the twenty-unsent policy while bounding only displayed records', async () => {
    const f = await fixture();
    await f.service.command({
      type: 'conversation.message.send',
      commandId: randomUUID(),
      chatId: f.chat.id,
      text: 'active',
    });
    await f.service.drain();
    const steering = await Promise.all(
      Array.from({ length: 35 }, (_, i) =>
        f.service.command({
          type: 'conversation.message.send',
          commandId: randomUUID(),
          chatId: f.chat.id,
          text: `steer ${i}`,
          behavior: 'steer',
        }),
      ),
    );
    expect(steering.every((result) => result.ok)).toBe(true);
    await vi.waitFor(() =>
      expect(
        f.store.pending(f.chat.id).filter((item) => item.state === 'submitted'),
      ).toHaveLength(36),
    );
    const unsent = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        f.service.command({
          type: 'conversation.message.send',
          commandId: randomUUID(),
          chatId: f.chat.id,
          text: `pending ${i}`,
          behavior: 'queue',
        }),
      ),
    );
    expect(unsent.every((result) => result.ok)).toBe(true);
    expect(
      await f.service.command({
        type: 'conversation.message.send',
        commandId: randomUUID(),
        chatId: f.chat.id,
        text: 'overflow',
        behavior: 'queue',
      }),
    ).toMatchObject({ ok: false, error: { code: 'QUEUE_FULL' } });
    const snapshot = await f.service.snapshot(f.chat.id);
    expect(
      snapshot.pending.filter((item) => item.state === 'pending'),
    ).toHaveLength(20);
    expect(snapshot.pending).toHaveLength(41);
    expect(snapshot.hiddenPendingCount).toBe(15);
    expect(f.store.pending(f.chat.id)).toHaveLength(56);
    expect(f.gateway.sends).toHaveLength(36);
  });
  it('keeps a worst-case escaped single-chat display frame below the negotiated thirty-two MiB character guard', async () => {
    const f = await fixture();
    f.gateway.ready = false;
    for (let position = 1; position <= 73; position++) {
      const item = seed(
        f.store,
        f.chat.id,
        position > 53 ? 'pending' : 'unknown',
        position,
      );
      item.text = '\u0000'.repeat(32000);
      f.store.savePending(item);
    }
    const insert = f.store.db.prepare(
      'INSERT INTO chat_tools VALUES (?, ?, ?, ?)',
    );
    for (let sequence = 1; sequence <= 100; sequence++)
      insert.run(
        f.chat.id,
        `tool-${sequence}`,
        sequence,
        JSON.stringify({
          id: `tool-${sequence}`,
          name: 'read',
          status: 'completed',
          parameters: '\u0000'.repeat(4096),
          output: '\u0000'.repeat(8192),
        }),
      );
    f.gateway.emit({
      type: 'chat',
      sessionKey: f.target.sessionKey,
      runId: 'escaped-preview',
      sequence: 1,
      state: 'delta',
      text: '\u0000'.repeat(previewLimit + 100),
      replace: true,
    });
    f.store.db
      .prepare(
        'INSERT INTO chat_history VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json',
      )
      .run(
        f.chat.id,
        JSON.stringify({
          messages: [
            {
              id: 'bounded-canonical-window',
              role: 'assistant',
              text: '\u0000'.repeat(40000),
              createdAt: 0,
            },
          ],
          hasOlderHistory: false,
          historyCursor: null,
        }),
      );
    const snapshot = await f.service.snapshot(f.chat.id);
    const frame = JSON.stringify({
      type: 'conversation.snapshot',
      snapshot,
      generation: 'resource-test',
      sequence: 1,
    });
    expect(frame.length).toBeLessThan(32 * 1024 * 1024);
    expect(snapshot.pending).toHaveLength(41);
    expect(snapshot.activeRun).toMatchObject({ truncated: true });
    expect(f.store.pending(f.chat.id)).toHaveLength(73);
  });
  it('shows every unsent message and the oldest recovery window without discarding retained accepted inputs', async () => {
    const f = await fixture();
    f.gateway.ready = false;
    const accepted = Array.from({ length: 53 }, (_, i) =>
      seed(f.store, f.chat.id, i % 2 === 0 ? 'unknown' : 'submitted', i + 1),
    );
    const pending = Array.from({ length: 20 }, (_, i) =>
      seed(f.store, f.chat.id, 'pending', 100 + i),
    );
    const before = f.store.pending(f.chat.id);
    f.store.db
      .prepare(
        'INSERT INTO chat_history VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json',
      )
      .run(
        f.chat.id,
        JSON.stringify({
          chat: f.chat,
          messages: [
            {
              id: 'existing-canonical',
              role: 'assistant',
              text: 'canonical cache survives upgrade',
              createdAt: 0,
            },
          ],
          pending: before,
          activeRun: {
            id: 'legacy-run',
            text: 'x'.repeat(previewLimit + 10),
            sequence: 1,
          },
          pendingSettings: null,
          hasOlderHistory: false,
          historyCursor: null,
        }),
      );
    const snapshot = await f.service.snapshot(f.chat.id);
    expect(snapshot.pending.map((item) => item.id)).toEqual(
      [...accepted.slice(0, 21), ...pending].map((item) => item.id),
    );
    expect(snapshot).toMatchObject({ hiddenPendingCount: 32 });
    expect(f.store.pending(f.chat.id)).toEqual(before);
    expect(snapshot.messages[0]?.text).toBe('canonical cache survives upgrade');
    const first = accepted[0];
    if (!first) throw new Error('Missing accepted record');
    f.gateway.ready = true;
    expect(
      (
        await f.service.command({
          type: 'conversation.message.resolveUnknown',
          commandId: randomUUID(),
          chatId: f.chat.id,
          messageId: first.id,
          revision: first.revision,
          action: 'discard',
        })
      ).ok,
    ).toBe(true);
    const next = await f.service.snapshot(f.chat.id);
    expect(next.pending.map((item) => item.id)).toEqual(
      [...accepted.slice(1, 22), ...pending].map((item) => item.id),
    );
    expect(next).toMatchObject({ hiddenPendingCount: 31 });
    expect(f.store.pending(f.chat.id)).toHaveLength(72);
  });
  it('bounds cumulative append frames and stored previews using replacement at the truncation boundary', async () => {
    const f = await fixture();
    const events: Extract<
      ConversationEvent,
      { type: 'conversation.run.text' }
    >[] = [];
    f.service.onEvent((event) => {
      if (event.type === 'conversation.run.text') events.push(event);
    });
    f.gateway.emit({
      type: 'chat',
      sessionKey: f.target.sessionKey,
      runId: 'run-preview',
      sequence: 1,
      state: 'delta',
      text: 'a'.repeat(previewLimit - 10),
      replace: false,
    });
    f.gateway.emit({
      type: 'chat',
      sessionKey: f.target.sessionKey,
      runId: 'run-preview',
      sequence: 2,
      state: 'delta',
      text: 'b'.repeat(100),
      replace: false,
    });
    const snapshot = await f.service.snapshot(f.chat.id);
    expect(snapshot.activeRun?.text.length).toBe(previewLimit);
    expect(
      snapshot.activeRun?.text ===
        'a'.repeat(previewLimit - 10) + 'b'.repeat(10),
    ).toBe(true);
    expect(snapshot.activeRun).toMatchObject({ truncated: true, sequence: 2 });
    expect(events.at(-1)).toMatchObject({
      replace: true,
      truncated: true,
    });
    expect(events.at(-1)?.text === snapshot.activeRun?.text).toBe(true);
    for (let sequence = 3; sequence < 15; sequence++)
      f.gateway.emit({
        type: 'chat',
        sessionKey: f.target.sessionKey,
        runId: 'run-preview',
        sequence,
        state: 'delta',
        text: 'c'.repeat(previewLimit),
        replace: false,
      });
    const frozen = (await f.service.snapshot(f.chat.id)).activeRun;
    expect(frozen).toMatchObject({
      truncated: true,
      sequence: 14,
    });
    expect(frozen?.text === snapshot.activeRun?.text).toBe(true);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.text.length <= previewLimit)).toBe(
      true,
    );
    f.gateway.emit({
      type: 'chat',
      sessionKey: f.target.sessionKey,
      runId: 'run-preview',
      sequence: 15,
      state: 'delta',
      text: 'short replacement',
      replace: true,
    });
    expect((await f.service.snapshot(f.chat.id)).activeRun).toMatchObject({
      text: 'short replacement',
      truncated: false,
      sequence: 15,
    });
    expect(events.at(-1)).toMatchObject({
      text: 'short replacement',
      replace: true,
      truncated: false,
    });
  });
  it('bounds authoritative reconnect preview while preserving the upstream run and canonical message content', async () => {
    const f = await fixture();
    const history = f.gateway.histories.get(f.target.sessionKey);
    if (!history) throw new Error('Missing upstream history');
    const full = 'x'.repeat(previewLimit + 1000);
    history.activeRun = { id: 'upstream-run', text: full, sequence: 42 };
    history.messages.push({
      id: 'canonical',
      role: 'assistant',
      text: full,
      createdAt: 0,
    });
    await f.service.reconcile();
    const snapshot = await f.service.snapshot(f.chat.id);
    expect(snapshot.activeRun?.text.length).toBe(previewLimit);
    expect(snapshot.activeRun).toMatchObject({ truncated: true });
    expect(snapshot.messages[0]?.text === full).toBe(true);
    expect(history.activeRun.text === full).toBe(true);
    expect(history.messages[0]?.text === full).toBe(true);
  });
});
