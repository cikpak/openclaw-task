import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ConversationEvent } from '@messenger/contracts';
import { Store } from '../src/database.js';
import { ChatService, mapping } from '../src/chats/service.js';
import { FakeGateway, testSettings } from './fake-gateway.js';
import { SettledRunProjection } from '../src/chats/projection.js';

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
  const runId = randomUUID();
  await service.command({
    type: 'conversation.message.send',
    commandId: runId,
    chatId: chat.id,
    text: 'Input',
  });
  await service.drain();
  const target = mapping(store.getChat(chat.id));
  const frames: ConversationEvent[] = [];
  service.onEvent((frame) => frames.push(frame));
  return { store, gateway, service, chat, runId, target, frames };
}
it('never publishes a terminal snapshot without either the preview or canonical answer', async () => {
  const f = await fixture();
  f.gateway.emit({
    type: 'chat',
    sessionKey: f.target.sessionKey,
    runId: f.runId,
    state: 'delta',
    sequence: 1,
    text: 'Visible partial',
    replace: false,
  });
  await vi.waitFor(() =>
    expect(
      f.frames.some((frame) => frame.type === 'conversation.run.text'),
    ).toBe(true),
  );
  const original = f.gateway.history.bind(f.gateway);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(f.gateway, 'history').mockImplementationOnce(async (...args) => {
    await delayed;
    return original(...args);
  });
  f.gateway.complete(f.target, f.runId, 2);
  await vi.waitFor(() => expect(f.store.pending(f.chat.id)).toEqual([]));
  const published = f.frames.filter(
    (frame) => frame.type === 'conversation.snapshot',
  );
  expect(published.length).toBeGreaterThan(0);
  // The completed preview is presentation-only, never an executable active run.
  for (const frame of published) {
    if (frame.type !== 'conversation.snapshot') continue;
    expect(frame.snapshot.activeRun).toBeNull();
    expect(JSON.stringify(frame.snapshot)).toContain('Visible partial');
  }
  const history = f.gateway.histories.get(f.target.sessionKey);
  if (!history) throw new Error('Missing history');
  history.messages.push({
    id: 'canonical-answer',
    role: 'assistant',
    text: 'Visible partial',
    createdAt: Date.now(),
    runId: f.runId,
  });
  release();
  await vi.waitFor(() =>
    expect(
      f.frames.some(
        (frame) =>
          frame.type === 'conversation.snapshot' &&
          frame.snapshot.messages.some(
            (message) => message.id === 'canonical-answer',
          ),
      ),
    ).toBe(true),
  );
  const canonical = await f.service.snapshot(f.chat.id);
  expect(canonical.settledRun).toBeUndefined();
  expect(
    canonical.messages.filter((message) => message.role === 'assistant'),
  ).toHaveLength(1);
});
it.each(['final', 'aborted', 'error'] as const)(
  'retains noncanonical %s text if terminal history fails, including HTTP snapshot reads',
  async (state) => {
    const f = await fixture();
    f.gateway.emit({
      type: 'chat',
      sessionKey: f.target.sessionKey,
      runId: f.runId,
      state: 'delta',
      sequence: 1,
      text: 'First',
      replace: false,
    });
    f.gateway.emit({
      type: 'chat',
      sessionKey: f.target.sessionKey,
      runId: f.runId,
      state: 'delta',
      sequence: 2,
      text: ' partial',
      replace: false,
    });
    await vi.waitFor(() =>
      expect(
        f.frames.filter((frame) => frame.type === 'conversation.run.text'),
      ).toHaveLength(2),
    );
    expect(
      f.frames
        .filter((frame) => frame.type === 'conversation.run.text')
        .map((frame) =>
          frame.type === 'conversation.run.text' ? frame.text : '',
        ),
    ).toEqual(['First', ' partial']);
    vi.spyOn(f.gateway, 'history').mockRejectedValue(
      new Error('Read unavailable'),
    );
    f.gateway.emit({
      type: 'chat',
      sessionKey: f.target.sessionKey,
      runId: f.runId,
      state,
      sequence: 3,
      text: '',
      replace: true,
    });
    await vi.waitFor(() => expect(f.store.pending(f.chat.id)).toEqual([]));
    const snapshot = await f.service.snapshot(f.chat.id);
    expect(snapshot.activeRun).toBeNull();
    expect(snapshot.settledRun).toMatchObject({
      id: f.runId,
      text: 'First partial',
      state,
    });
    expect(snapshot.messages).not.toContainEqual(
      expect.objectContaining({ text: 'First partial' }),
    );
    f.gateway.emit({
      type: 'chat',
      sessionKey: f.target.sessionKey,
      runId: f.runId,
      state: 'delta',
      sequence: 4,
      text: 'late',
      replace: false,
    });
    f.gateway.emit({
      type: 'chat',
      sessionKey: f.target.sessionKey,
      runId: f.runId,
      state,
      sequence: 5,
      text: '',
      replace: true,
    });
    expect((await f.service.snapshot(f.chat.id)).settledRun?.text).toBe(
      'First partial',
    );
  },
);
it('retires only confirmed canonical matches or newly observed untagged assistant records, and bounds presentation memory', () => {
  const projection = new SettledRunProjection();
  const run = { id: 'finished', text: 'Preview', sequence: 2 };
  const old = {
    id: 'old',
    role: 'assistant' as const,
    text: 'Older answer',
    createdAt: 1,
  };
  projection.capture('chat', run, 'final', [old]);
  projection.reconcile('chat', [old], null);
  expect(projection.get('chat')).toBeDefined();
  projection.reconcile(
    'chat',
    [{ ...old, id: 'other', runId: 'different' }],
    null,
  );
  expect(projection.get('chat')).toBeDefined();
  projection.reconcile(
    'chat',
    [{ ...old, id: 'canonical', runId: 'finished' }],
    null,
  );
  expect(projection.get('chat')).toBeUndefined();
  projection.capture('chat', run, 'final', [old]);
  projection.reconcile(
    'chat',
    [{ ...old, id: 'new-canonical-without-run-id' }],
    null,
  );
  expect(projection.get('chat')).toBeUndefined();
  projection.capture('chat', run, 'aborted', [old]);
  projection.reconcile('chat', [old], {
    id: 'newer-run',
    text: 'Live',
    sequence: 1,
  });
  expect(projection.get('chat')).toBeUndefined();
  for (let i = 0; i < 11; i++)
    projection.capture(`chat-${i}`, run, 'final', []);
  expect(projection.get('chat-0')).toBeUndefined();
  projection.discard('chat-10');
  expect(projection.get('chat-10')).toBeUndefined();
  projection.clear();
  expect(projection.get('chat-9')).toBeUndefined();
});
it.each(['final', 'error', 'aborted'] as const)(
  'keeps %s preview when history contains only unchanged earlier same-run commentary',
  (state) => {
    const projection = new SettledRunProjection();
    const commentary = {
      id: 'commentary',
      role: 'assistant' as const,
      runId: 'finished',
      text: 'Checking the file',
      createdAt: 1,
    };
    const run = { id: 'finished', text: 'Final visible answer', sequence: 10 };
    projection.capture('chat', run, state, [commentary]);
    // Updated observation metadata alone does not make commentary a final answer.
    projection.reconcile(
      'chat',
      [{ ...commentary, createdAt: 2, historySequence: 2 }],
      null,
    );
    expect(projection.get('chat')).toEqual({ ...run, state });
    projection.reconcile(
      'chat',
      [{ ...commentary, id: 'canonical-final', text: run.text }],
      null,
    );
    expect(projection.get('chat')).toBeUndefined();
  },
);
it('retires an updated known record only for the exact same run, not text-only or cross-run matches', () => {
  const projection = new SettledRunProjection();
  const commentary = {
    id: 'same-record',
    role: 'assistant' as const,
    runId: 'finished',
    text: 'Earlier commentary',
    createdAt: 1,
  };
  const run = {
    id: 'finished',
    text: 'Partial visible answer',
    sequence: 2,
    truncated: true,
  };
  projection.capture('chat', run, 'final', [commentary]);
  projection.reconcile(
    'chat',
    [{ ...commentary, runId: 'different', text: run.text }],
    null,
  );
  expect(projection.get('chat')).toBeDefined();
  projection.reconcile(
    'chat',
    [{ ...commentary, runId: undefined, text: run.text }],
    null,
  );
  expect(projection.get('chat')).toBeDefined();
  // Corrected canonical content need not match the truncated preview's prefix.
  projection.reconcile(
    'chat',
    [{ ...commentary, text: 'Corrected canonical answer beyond the preview' }],
    null,
  );
  expect(projection.get('chat')).toBeUndefined();
});
it.each([false, true])(
  'retires an already captured same-run final record with truncated=%s',
  (truncated) => {
    const projection = new SettledRunProjection();
    const run = {
      id: 'finished',
      text: 'Canonical answer',
      sequence: 2,
      truncated,
    };
    const canonical = {
      id: 'canonical',
      role: 'assistant' as const,
      runId: run.id,
      text: run.text + (truncated ? ' beyond the preview boundary' : ''),
      createdAt: 1,
    };
    projection.capture('chat', run, 'final', [canonical]);
    projection.reconcile('chat', [canonical], null);
    expect(projection.get('chat')).toBeUndefined();
  },
);
