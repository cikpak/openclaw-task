import { beforeEach, expect, it } from 'vitest';
import { snapshot, models } from '../test/fixtures';
import { useChatProjection, useDrafts, useModelCatalog } from './stores';
import { frameValid } from '../lib/validation';
beforeEach(() => {
  useChatProjection.getState().clear();
  useDrafts.getState().clear();
  useModelCatalog.getState().clear();
});
it('rejects malformed or oversized projected window markers before store mutation', () => {
  expect(
    frameValid({
      type: 'conversation.snapshot',
      generation: 'one',
      sequence: 1,
      snapshot: { ...snapshot, hiddenPendingCount: -1 },
    }),
  ).toBe(false);
  expect(
    frameValid({
      type: 'conversation.snapshot',
      generation: 'one',
      sequence: 1,
      snapshot: {
        ...snapshot,
        activeRun: { id: 'run', text: 'x', sequence: 1, truncated: 'yes' },
      },
    }),
  ).toBe(false);
  expect(
    frameValid({
      type: 'conversation.run.text',
      generation: 'one',
      sequence: 1,
      chatId: 'chat-a',
      runId: 'run',
      text: 'x'.repeat(256 * 1024 + 1),
      replace: true,
      runSequence: 1,
    }),
  ).toBe(false);
});
it('retires old tombstones only after a fresh current-epoch catalog and rejects older-epoch results', () => {
  const store = useChatProjection.getState();
  store.receiveEvent({
    type: 'connection.state',
    generation: 'one',
    sequence: 0,
    state: 'ready',
  });
  store.applySnapshot(snapshot);
  const oldEpoch = useChatProjection.getState().connectionEpoch;
  store.receiveEvent({
    type: 'conversation.deleted',
    generation: 'one',
    sequence: 1,
    chatId: 'chat-a',
  });
  store.beginConnection();
  const currentEpoch = useChatProjection.getState().connectionEpoch;
  expect(useChatProjection.getState().deletedChats['chat-a']).toBeTruthy();
  store.applySnapshotResult([snapshot], {}, true, 1, oldEpoch);
  expect(useChatProjection.getState().chats['chat-a']).toBeUndefined();
  expect(useChatProjection.getState().deletedChats['chat-a']).toBeTruthy();
  store.receiveEvent({
    type: 'connection.state',
    generation: 'one',
    sequence: 0,
    state: 'ready',
  });
  store.applySnapshotResult(
    [{ ...snapshot, chat: { ...snapshot.chat, id: 'chat-b' } }],
    {},
    true,
    2,
    currentEpoch,
  );
  expect(useChatProjection.getState().deletedChats['chat-a']).toBeUndefined();
  store.applySnapshotResult([snapshot], {}, true, 3, oldEpoch);
  expect(useChatProjection.getState().chats['chat-a']).toBeUndefined();
  expect(useChatProjection.getState().chats['chat-b']).toBeDefined();
});
it('releases drafts and scoped catalogs for chats confirmed absent in a reconnect catalog', () => {
  const store = useChatProjection.getState();
  store.applySnapshot(snapshot);
  useDrafts.getState().setText('chat-a', 'Old offline draft');
  useDrafts
    .getState()
    .beginCorrection('chat-a', 'correction', 'Old offline correction', 1);
  useModelCatalog.setState({
    catalogs: { 'chat-a': models, defaults: models },
  });
  store.beginConnection();
  const epoch = useChatProjection.getState().connectionEpoch;
  store.receiveEvent({
    type: 'connection.state',
    generation: 'new',
    sequence: 0,
    state: 'ready',
  });
  store.applyCatalogResult([], {}, epoch);
  expect(useDrafts.getState().drafts['chat-a']).toBeUndefined();
  expect(useDrafts.getState().corrections.correction).toBeUndefined();
  expect(useModelCatalog.getState().catalogs['chat-a']).toBeUndefined();
  expect(useChatProjection.getState().deletedChats['chat-a']).toBeTruthy();
  store.applySnapshotResult([snapshot], {}, false, 1, epoch);
  expect(useChatProjection.getState().chats['chat-a']).toBeUndefined();
});
it('keeps tool replay watermarks limited to the 100 retained tools', () => {
  const store = useChatProjection.getState();
  store.receiveEvent({
    type: 'connection.state',
    generation: 'one',
    sequence: 0,
    state: 'ready',
  });
  store.applySnapshot(snapshot);
  for (let index = 1; index <= 250; index++)
    store.receiveEvent({
      type: 'conversation.tool',
      generation: 'one',
      sequence: index,
      chatId: 'chat-a',
      tool: {
        id: `tool-${index}`,
        name: 'read',
        status: 'running',
        parameters: '{}',
        output: '',
      },
    });
  const state = useChatProjection.getState();
  expect(state.tools['chat-a']).toHaveLength(100);
  expect(Object.keys(state.toolEventSequences['chat-a'] ?? {})).toHaveLength(
    100,
  );
  expect(Object.keys(state.toolEventSequences['chat-a'] ?? {})).toEqual(
    state.tools['chat-a']?.map((tool) => tool.id),
  );
  const before = { ...state.chatSequences };
  store.receiveEvent({
    type: 'conversation.tool',
    generation: 'one',
    sequence: 251,
    chatId: 'chat-a',
    tool: {
      id: 'tool-250',
      name: 'read',
      status: 'completed',
      parameters: '{}',
      output: 'Newest',
    },
  });
  store.applySnapshotResult([{ ...snapshot, tools: [] }], before, false, 1);
  expect(useChatProjection.getState().tools['chat-a']?.at(-1)?.output).toBe(
    'Newest',
  );
  expect(
    Object.keys(
      useChatProjection.getState().toolEventSequences['chat-a'] ?? {},
    ),
  ).toEqual(['tool-250']);
});
it('releases only confirmed-deleted chat caches while retaining a stale-result tombstone', () => {
  const store = useChatProjection.getState();
  store.receiveEvent({
    type: 'connection.state',
    generation: 'one',
    sequence: 0,
    state: 'ready',
  });
  store.applySnapshot(snapshot);
  store.applySnapshot({
    ...snapshot,
    chat: { ...snapshot.chat, id: 'chat-b' },
  });
  store.prependHistory(
    'chat-a',
    [{ id: 'older', role: 'user', text: 'Older', createdAt: 0 }],
    null,
    false,
  );
  useDrafts.getState().setText('chat-a', 'Draft A');
  useDrafts.getState().setText('chat-b', 'Draft B');
  useDrafts
    .getState()
    .beginCorrection('chat-a', 'correction-a', 'Keep until confirmed', 1);
  useDrafts
    .getState()
    .beginCorrection('chat-b', 'correction-b', 'B correction', 1);
  useModelCatalog.setState({
    catalogs: { 'chat-a': models, 'chat-b': models, defaults: models },
  });
  store.receiveEvent({
    type: 'conversation.run.text',
    generation: 'one',
    sequence: 1,
    chatId: 'chat-a',
    runId: 'run',
    runSequence: 1,
    text: 'Text',
    replace: false,
  });
  store.receiveEvent({
    type: 'conversation.tool',
    generation: 'one',
    sequence: 2,
    chatId: 'chat-a',
    tool: {
      id: 'tool-a',
      name: 'read',
      status: 'completed',
      parameters: '{}',
      output: 'done',
    },
  });
  useChatProjection.setState({
    runDropped: {
      'chat-a': {
        type: 'conversation.run.text',
        generation: 'one',
        sequence: 1,
        chatId: 'chat-a',
        runId: 'run',
        runSequence: 1,
        text: 'Dropped',
        replace: false,
      },
    },
    resyncChats: { 'chat-a': true },
    snapshotReadOrders: { 'chat-a': 1 },
  });
  store.receiveEvent({
    type: 'conversation.updated',
    generation: 'one',
    sequence: 3,
    chat: { ...snapshot.chat, status: 'deleting' },
  });
  expect(useDrafts.getState().corrections['correction-a']?.text).toBe(
    'Keep until confirmed',
  );
  store.receiveEvent({
    type: 'conversation.deleted',
    generation: 'one',
    sequence: 4,
    chatId: 'chat-a',
  });
  const state = useChatProjection.getState();
  for (const map of [
    state.chats,
    state.snapshots,
    state.tools,
    state.olderHistory,
    state.runBacklog,
    state.runDropped,
    state.resyncChats,
    state.chatSequences,
    state.structuralSequences,
    state.runEventSequences,
    state.snapshotReadOrders,
    state.toolEventSequences,
  ])
    expect(map).not.toHaveProperty('chat-a');
  expect(useDrafts.getState().drafts).not.toHaveProperty('chat-a');
  expect(useDrafts.getState().corrections).not.toHaveProperty('correction-a');
  expect(useModelCatalog.getState().catalogs).not.toHaveProperty('chat-a');
  expect(useDrafts.getState().drafts['chat-b']?.text).toBe('Draft B');
  expect(useDrafts.getState().corrections['correction-b']).toBeDefined();
  expect(useModelCatalog.getState().catalogs.defaults).toEqual(models);
  expect(state.deletedChats['chat-a']).toBeTruthy();
  store.applySnapshotResult([snapshot], {}, true, 0);
  store.receiveEvent({
    type: 'conversation.tool',
    generation: 'one',
    sequence: 5,
    chatId: 'chat-a',
    tool: {
      id: 'late-tool',
      name: 'read',
      status: 'completed',
      parameters: '{}',
      output: 'late',
    },
  });
  expect(useChatProjection.getState().chats['chat-a']).toBeUndefined();
  expect(useChatProjection.getState().tools['chat-a']).toBeUndefined();
  expect(
    useChatProjection.getState().toolEventSequences['chat-a'],
  ).toBeUndefined();
});
