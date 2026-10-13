import { beforeEach, expect, it } from 'vitest';
import type { Message } from '@messenger/contracts';
import { snapshot } from '../test/fixtures';
import { modelValid, snapshotValid } from '../lib/validation';
import { useChatProjection } from './stores';

beforeEach(() => useChatProjection.getState().clear());
const message = (
  id: string,
  createdAt: number,
  historySequence?: number,
): Message => ({
  id,
  role: 'assistant',
  text: id,
  createdAt,
  ...(historySequence !== undefined ? { historySequence } : {}),
});
const ids = () =>
  useChatProjection
    .getState()
    .snapshots[snapshot.chat.id]?.messages.map((item) => item.id);
it('does not revive terminal preview from late text and retires it when a new run begins', () => {
  const store = useChatProjection.getState();
  store.receiveEvent({
    type: 'connection.state',
    generation: 'g',
    sequence: 0,
    state: 'ready',
  });
  store.applySnapshot({
    ...snapshot,
    settledRun: {
      id: 'finished',
      text: 'Partial',
      sequence: 2,
      state: 'error',
    },
  });
  store.receiveEvent({
    type: 'conversation.run.text',
    generation: 'g',
    sequence: 1,
    chatId: snapshot.chat.id,
    runId: 'finished',
    runSequence: 3,
    text: 'Late',
    replace: false,
  });
  expect(
    useChatProjection.getState().snapshots[snapshot.chat.id]?.activeRun,
  ).toBeNull();
  store.receiveEvent({
    type: 'conversation.run.text',
    generation: 'g',
    sequence: 2,
    chatId: snapshot.chat.id,
    runId: 'next',
    runSequence: 1,
    text: 'Fresh',
    replace: false,
  });
  const next = useChatProjection.getState().snapshots[snapshot.chat.id];
  expect(next?.activeRun?.text).toBe('Fresh');
  expect(next?.settledRun).toBeUndefined();
});
it('normalizes newest-first snapshots using canonical display sequence even with contradictory timestamps', () => {
  useChatProjection.getState().applySnapshot({
    ...snapshot,
    messages: [
      message('third', 1, 3),
      message('second', 3, 2),
      message('first', 4, 1),
    ],
  });
  expect(ids()).toEqual(['first', 'second', 'third']);
});
it('keeps stable ties and unknown timestamps without treating zero as real chronology', () => {
  useChatProjection.getState().applySnapshot({
    ...snapshot,
    messages: [
      message('new', 3),
      message('unknown', 0),
      message('tie-a', 1),
      message('tie-b', 1),
    ],
  });
  expect(ids()).toEqual(['tie-a', 'unknown', 'tie-b', 'new']);
});
it('deduplicates reversed overlapping older pages and reconnect snapshots without reordering queued work', () => {
  const store = useChatProjection.getState();
  store.applySnapshot({
    ...snapshot,
    messages: [message('four', 4, 4), message('three', 3, 3)],
  });
  store.prependHistory(
    snapshot.chat.id,
    [message('three', 3, 3), message('two', 2, 2), message('one', 1, 1)],
    'older:3',
    true,
  );
  expect(ids()).toEqual(['one', 'two', 'three', 'four']);
  store.applySnapshot({
    ...snapshot,
    messages: [message('five', 5, 5), message('four', 4, 4)],
  });
  expect(ids()).toEqual(['one', 'two', 'three', 'four', 'five']);
  expect(
    useChatProjection.getState().snapshots[snapshot.chat.id]?.pending,
  ).toEqual(snapshot.pending);
});
it('validates optional ordering, settled-preview and explicit speed-support metadata', () => {
  expect(snapshotValid({ ...snapshot, messages: [message('a', 1, -1)] })).toBe(
    false,
  );
  const settledRun = {
    id: 'run',
    text: 'Partial',
    sequence: 3,
    state: 'aborted',
  };
  expect(snapshotValid({ ...snapshot, settledRun })).toBe(true);
  expect(
    snapshotValid({
      ...snapshot,
      settledRun,
      activeRun: { id: 'live', text: 'Live', sequence: 1 },
    }),
  ).toBe(false);
  expect(
    snapshotValid({ ...snapshot, settledRun: { ...settledRun, id: '' } }),
  ).toBe(false);
  expect(
    snapshotValid({ ...snapshot, settledRun: { ...settledRun, text: '' } }),
  ).toBe(false);
  expect(
    snapshotValid({
      ...snapshot,
      settledRun: { ...settledRun, state: 'running' },
    }),
  ).toBe(false);
  const model = {
    id: 'test/model',
    name: 'Test',
    provider: 'test',
    available: true,
    thinkingLevels: [],
    thinkingDefault: 'off',
    supportsFastMode: false,
    input: ['text'],
  };
  expect(modelValid({ ...model, fastModeSupport: 'unknown' })).toBe(true);
  expect(modelValid({ ...model, fastModeSupport: 'guessed' })).toBe(false);
  expect(modelValid({ ...model, fastModeSupport: 'supported' })).toBe(false);
});
