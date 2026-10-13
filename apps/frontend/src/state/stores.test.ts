import { beforeEach, describe, expect, it } from 'vitest';
import { frameValid } from '../lib/validation';
import { snapshot } from '../test/fixtures';
import { useChatProjection, useDrafts } from './stores';
beforeEach(() => {
  useChatProjection.getState().clear();
  useDrafts.getState().clear();
});
describe('draft ownership', () => {
  it('keeps a later queued correction draft and advances only its confirmed resource revision', () => {
    const store = useDrafts.getState();
    store.beginCorrection('chat-a', 'message', 'Original', 1);
    store.updateCorrection('message', 'First correction');
    const submitted = useDrafts.getState().corrections.message;
    store.updateCorrection('message', 'Later correction');
    store.acceptCorrection('message', submitted?.draftRevision ?? 0, 2);
    expect(useDrafts.getState().corrections.message).toMatchObject({
      text: 'Later correction',
      revision: 2,
    });
  });
  it('only clears the accepted revision, preserving text typed during delivery', () => {
    const store = useDrafts.getState();
    store.setText('a', 'First');
    const sent = useDrafts.getState().drafts.a;
    store.setText('a', 'Second');
    store.acceptRevision('a', sent?.revision ?? 0);
    expect(useDrafts.getState().drafts.a?.text).toBe('Second');
    store.acceptRevision('a', useDrafts.getState().drafts.a?.revision ?? 0);
    expect(useDrafts.getState().drafts.a?.text).toBe('');
  });
  it('keeps independent drafts across route changes', () => {
    useDrafts.getState().setText('a', 'A');
    useDrafts.getState().setText('b', 'B');
    expect(useDrafts.getState().drafts.a?.text).toBe('A');
    expect(useDrafts.getState().drafts.b?.text).toBe('B');
  });
});
describe('safe authoritative projection', () => {
  it('replays append events on the authoritative reconnect base instead of preserving stale cached concatenation', () => {
    const store = useChatProjection.getState();
    store.applySnapshot({
      ...snapshot,
      activeRun: { id: 'run', text: 'A', sequence: 1 },
    });
    store.beginConnection();
    store.receiveEvent({
      type: 'connection.state',
      generation: 'new',
      sequence: 0,
      state: 'ready',
    });
    store.receiveEvent({
      type: 'conversation.run.text',
      generation: 'new',
      sequence: 1,
      chatId: 'chat-a',
      runId: 'run',
      runSequence: 3,
      text: 'C',
      replace: false,
    });
    expect(
      useChatProjection.getState().snapshots['chat-a']?.activeRun?.text,
    ).toBe('AC');
    store.applySnapshotResult(
      [{ ...snapshot, activeRun: { id: 'run', text: 'AB', sequence: 2 } }],
      {},
      true,
      1,
    );
    expect(
      useChatProjection.getState().snapshots['chat-a']?.activeRun?.text,
    ).toBe('ABC');
  });
  it('flags an append sequence gap after bounded stream buffers overflow', () => {
    const store = useChatProjection.getState();
    store.receiveEvent({
      type: 'connection.state',
      generation: 'new',
      sequence: 0,
      state: 'ready',
    });
    store.applySnapshot({
      ...snapshot,
      activeRun: { id: 'run', text: 'A', sequence: 1 },
    });
    for (let index = 2; index <= 103; index++)
      store.receiveEvent({
        type: 'conversation.run.text',
        generation: 'new',
        sequence: index,
        chatId: 'chat-a',
        runId: 'run',
        runSequence: index,
        text: 'x',
        replace: false,
      });
    store.applySnapshotResult(
      [{ ...snapshot, activeRun: { id: 'run', text: 'A', sequence: 1 } }],
      {},
      false,
      1,
    );
    expect(useChatProjection.getState().resyncChats['chat-a']).toBe(true);
    expect(useChatProjection.getState().runBacklog['chat-a']).toBeUndefined();
  });
  it('merges offline history and queue after reconnect while preserving intervening stream and tool events', () => {
    const store = useChatProjection.getState();
    store.applySnapshot({
      ...snapshot,
      activeRun: { id: 'run', text: 'Old', sequence: 1 },
      tools: [],
    });
    store.beginConnection();
    store.receiveEvent({
      type: 'connection.state',
      generation: 'new',
      sequence: 0,
      state: 'ready',
    });
    const watermark = { ...useChatProjection.getState().chatSequences };
    store.receiveEvent({
      type: 'conversation.run.text',
      generation: 'new',
      sequence: 1,
      chatId: 'chat-a',
      runId: 'run',
      runSequence: 3,
      text: 'Newest stream',
      replace: true,
    });
    store.receiveEvent({
      type: 'conversation.tool',
      generation: 'new',
      sequence: 2,
      chatId: 'chat-a',
      tool: {
        id: 'live',
        name: 'write',
        status: 'completed',
        parameters: '{}',
        output: 'Latest output',
      },
    });
    store.applySnapshotResult(
      [
        {
          ...snapshot,
          messages: [
            {
              id: 'offline',
              role: 'assistant',
              text: 'Offline answer',
              createdAt: 2,
            },
          ],
          pending: [
            {
              id: 'queued',
              chatId: 'chat-a',
              position: 1,
              text: 'Offline queued',
              attachments: [],
              revision: 1,
              state: 'pending',
              submissionId: 'submission',
              createdAt: 3,
            },
          ],
          activeRun: { id: 'run', text: 'Older snapshot stream', sequence: 2 },
          tools: [
            {
              id: 'offline-tool',
              name: 'read',
              status: 'completed',
              parameters: '{}',
              output: 'Offline output',
            },
          ],
        },
      ],
      watermark,
      true,
      1,
    );
    expect(
      useChatProjection.getState().snapshots['chat-a']?.messages[0]?.text,
    ).toBe('Offline answer');
    expect(
      useChatProjection.getState().snapshots['chat-a']?.pending[0]?.text,
    ).toBe('Offline queued');
    expect(
      useChatProjection.getState().snapshots['chat-a']?.activeRun?.text,
    ).toBe('Newest stream');
    expect(
      useChatProjection.getState().tools['chat-a']?.map((tool) => tool.id),
    ).toEqual(['offline-tool', 'live']);
  });
  it('cannot overwrite a newer snapshot result with an older result at the same event watermark', () => {
    const store = useChatProjection.getState();
    store.applySnapshotResult(
      [{ ...snapshot, chat: { ...snapshot.chat, name: 'Newer' } }],
      {},
      false,
      2,
    );
    store.applySnapshotResult(
      [{ ...snapshot, chat: { ...snapshot.chat, name: 'Older' } }],
      {},
      true,
      1,
    );
    expect(useChatProjection.getState().snapshots['chat-a']?.chat.name).toBe(
      'Newer',
    );
    expect(useChatProjection.getState().chats['chat-a']?.name).toBe('Newer');
  });
  it('accepts an unrelated chat snapshot while another chat streams, without retry starvation', () => {
    const store = useChatProjection.getState();
    store.receiveEvent({
      type: 'connection.state',
      generation: 'one',
      sequence: 0,
      state: 'ready',
    });
    store.applySnapshot({ ...snapshot, chat: { ...snapshot.chat, id: 'b' } });
    const watermark = { ...useChatProjection.getState().chatSequences };
    store.receiveEvent({
      type: 'conversation.run.text',
      generation: 'one',
      sequence: 1,
      chatId: 'b',
      runId: 'b-run',
      runSequence: 1,
      text: 'Busy',
      replace: false,
    });
    store.applySnapshotResult([snapshot], watermark, false);
    expect(useChatProjection.getState().snapshots['chat-a']?.chat.name).toBe(
      'Research',
    );
    expect(useChatProjection.getState().snapshots.b?.activeRun?.text).toBe(
      'Busy',
    );
  });
  it('preserves concurrent chat updates when an all-chat result arrives', () => {
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
      sequence: 1,
      snapshot: {
        ...snapshot,
        chat: { ...snapshot.chat, id: 'new-chat', name: 'New' },
      },
    });
    store.applySnapshotResult([snapshot], {}, true);
    expect(Object.keys(useChatProjection.getState().chats)).toEqual([
      'chat-a',
      'new-chat',
    ]);
  });
  it('replays bounded pre-snapshot text only beyond the snapshot run sequence', () => {
    const store = useChatProjection.getState();
    store.receiveEvent({
      type: 'connection.state',
      generation: 'one',
      sequence: 0,
      state: 'ready',
    });
    store.receiveEvent({
      type: 'conversation.run.text',
      generation: 'one',
      sequence: 1,
      chatId: 'chat-a',
      runId: 'run',
      runSequence: 2,
      text: 'new',
      replace: false,
    });
    store.applySnapshotResult(
      [{ ...snapshot, activeRun: { id: 'run', sequence: 1, text: 'Base ' } }],
      {},
      true,
    );
    expect(
      useChatProjection.getState().snapshots['chat-a']?.activeRun?.text,
    ).toBe('Base new');
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
});
