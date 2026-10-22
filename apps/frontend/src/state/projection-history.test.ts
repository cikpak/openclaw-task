import { beforeEach, expect, it } from 'vitest';
import { frameValid } from '../lib/validation';
import { snapshot } from '../test/fixtures';
import { useChatProjection, useDrafts } from './stores';
beforeEach(() => {
  useChatProjection.getState().clear();
  useDrafts.getState().clear();
});
it('retains multiple earlier pages, chronological order and cursor through recent snapshots', () => {
  const store = useChatProjection.getState();
  store.applySnapshot({
    ...snapshot,
    messages: [
      { id: 'recent', role: 'assistant', text: 'Recent', createdAt: 30 },
    ],
    hasOlderHistory: true,
    historyCursor: 'recent',
  });
  store.prependHistory(
    'chat-a',
    [{ id: 'older', role: 'user', text: 'Older', createdAt: 20 }],
    'older',
    true,
  );
  store.prependHistory(
    'chat-a',
    [{ id: 'oldest', role: 'user', text: 'Oldest', createdAt: 10 }],
    null,
    false,
  );
  store.applySnapshot({
    ...snapshot,
    messages: [
      { id: 'recent', role: 'assistant', text: 'Recent', createdAt: 30 },
      { id: 'latest', role: 'assistant', text: 'Latest', createdAt: 40 },
    ],
    hasOlderHistory: true,
    historyCursor: 'reset',
  });
  expect(
    useChatProjection
      .getState()
      .snapshots['chat-a']?.messages.map((message) => message.id),
  ).toEqual(['oldest', 'older', 'recent', 'latest']);
  expect(
    useChatProjection.getState().snapshots['chat-a']?.historyCursor,
  ).toBeNull();
  expect(
    useChatProjection.getState().snapshots['chat-a']?.hasOlderHistory,
  ).toBe(false);
});
it('retains tool updates during text streaming rather than restoring stale snapshot tools', () => {
  const store = useChatProjection.getState();
  store.receiveEvent({
    type: 'connection.state',
    generation: 'one',
    sequence: 0,
    state: 'ready',
  });
  store.applySnapshot({ ...snapshot, tools: [] });
  store.receiveEvent({
    type: 'conversation.tool',
    generation: 'one',
    sequence: 1,
    chatId: 'chat-a',
    tool: {
      id: 'tool',
      name: 'write',
      status: 'completed',
      parameters: '{}',
      output: 'done',
    },
  });
  store.receiveEvent({
    type: 'conversation.run.text',
    generation: 'one',
    sequence: 2,
    chatId: 'chat-a',
    runId: 'run',
    runSequence: 1,
    text: 'Done',
    replace: true,
  });
  expect(useChatProjection.getState().tools['chat-a']).toHaveLength(1);
});
it('rejects timestamps outside Date bounds and noninteger event sequences', () => {
  expect(
    frameValid({
      type: 'conversation.snapshot',
      generation: 'one',
      sequence: 1,
      snapshot: {
        ...snapshot,
        messages: [
          { id: 'bad', role: 'assistant', text: 'bad', createdAt: 1e30 },
        ],
      },
    }),
  ).toBe(false);
  expect(
    frameValid({
      type: 'connection.state',
      generation: 'one',
      sequence: 0.5,
      state: 'ready',
    }),
  ).toBe(false);
});
it('rejects malformed and unknown frames and cross-chat queue data', () => {
  expect(
    frameValid({
      type: 'conversation.snapshot',
      generation: 'one',
      sequence: 1,
      snapshot: { ...snapshot, pending: [{ id: 'x', chatId: 'other' }] },
    }),
  ).toBe(false);
  expect(
    frameValid({
      type: 'future.unrecognized',
      generation: 'one',
      sequence: 1,
    }),
  ).toBe(false);
  expect(
    frameValid({
      type: 'conversation.run.text',
      chatId: 'a',
      generation: 'one',
      sequence: 1,
      text: 9,
    }),
  ).toBe(false);
  expect(
    frameValid({
      type: 'command.result',
      ok: false,
      commandId: 'x',
      error: { detail: 'unsafe' },
    }),
  ).toBe(false);
});
it('rejects old snapshots and events from prior connections', () => {
  const store = useChatProjection.getState();
  store.receiveEvent({
    type: 'connection.state',
    generation: 'one',
    sequence: 0,
    state: 'ready',
  });
  store.receiveEvent({
    type: 'conversation.snapshot',
    generation: 'one',
    sequence: 2,
    snapshot,
  });
  store.receiveEvent({
    type: 'conversation.snapshot',
    generation: 'one',
    sequence: 1,
    snapshot: { ...snapshot, chat: { ...snapshot.chat, name: 'Stale' } },
  });
  store.receiveEvent({
    type: 'conversation.updated',
    generation: 'old',
    sequence: 99,
    chat: { ...snapshot.chat, name: 'Wrong connection' },
  });
  expect(useChatProjection.getState().chats['chat-a']?.name).toBe('Research');
});
it('applies append and replacement streams without replaying stale text', () => {
  const store = useChatProjection.getState();
  store.receiveEvent({
    type: 'connection.state',
    generation: 'one',
    sequence: 0,
    state: 'ready',
  });
  store.applySnapshot(snapshot);
  store.receiveEvent({
    type: 'conversation.run.text',
    generation: 'one',
    sequence: 1,
    chatId: 'chat-a',
    runId: 'run',
    runSequence: 1,
    text: 'Hello',
    replace: false,
  });
  store.receiveEvent({
    type: 'conversation.run.text',
    generation: 'one',
    sequence: 2,
    chatId: 'chat-a',
    runId: 'run',
    runSequence: 2,
    text: 'Hello world',
    replace: true,
  });
  store.receiveEvent({
    type: 'conversation.run.text',
    generation: 'one',
    sequence: 3,
    chatId: 'chat-a',
    runId: 'run',
    runSequence: 1,
    text: ' duplicate',
    replace: false,
  });
  expect(
    useChatProjection.getState().snapshots['chat-a']?.activeRun?.text,
  ).toBe('Hello world');
});
