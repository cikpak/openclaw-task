import { act, render, screen } from '@testing-library/react';
import type { ChatSnapshot } from '@messenger/contracts';
import { beforeEach, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { snapshot } from '../test/fixtures';
import { useChatProjection } from '../state/stores';
import { messageValid } from '../lib/validation';
import { ConversationHeader } from '../conversation/ConversationHeader';
import { ChatStatusDot, chatVisualStatus } from './ChatStatusDot';

beforeEach(() => useChatProjection.getState().clear());

const reply = {
  id: 'reply',
  role: 'assistant' as const,
  text: 'Done.',
  createdAt: 2,
};
const answered: ChatSnapshot = { ...snapshot, messages: [reply] };

it('keeps new or unread-only conversations neutral without inventing a successful reply', () => {
  expect(chatVisualStatus(snapshot.chat, snapshot)).toBe('idle');
  expect(chatVisualStatus({ ...snapshot.chat, unread: true })).toBe('idle');
});

it('shows working while a run is active even when previous responses exist', () => {
  expect(
    chatVisualStatus({ ...snapshot.chat, status: 'running' }, answered),
  ).toBe('working');
  expect(
    chatVisualStatus(snapshot.chat, {
      ...answered,
      activeRun: { id: 'next', text: '', sequence: 1 },
    }),
  ).toBe('working');
});

it('keeps a received reply green after it is read, including document-only replies', () => {
  expect(chatVisualStatus(snapshot.chat, answered)).toBe('answered');
  expect(
    chatVisualStatus(snapshot.chat, {
      ...snapshot,
      messages: [
        {
          ...reply,
          text: '',
          artifacts: [
            {
              id: 'file',
              name: 'report.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 10,
            },
          ],
        },
      ],
    }),
  ).toBe('answered');
});

it('uses explicit terminal and canonical failure evidence, never error-like reply text', () => {
  expect(
    chatVisualStatus(snapshot.chat, {
      ...answered,
      settledRun: {
        id: 'failed',
        text: 'Partial',
        sequence: 1,
        state: 'error',
      },
    }),
  ).toBe('failed');
  expect(
    chatVisualStatus(snapshot.chat, {
      ...answered,
      messages: [
        reply,
        { ...reply, id: 'failed', text: '', requestFailed: true },
      ],
    }),
  ).toBe('failed');
  expect(
    chatVisualStatus(snapshot.chat, {
      ...snapshot,
      messages: [{ ...reply, text: 'Here is how to handle a failed request.' }],
    }),
  ).toBe('answered');
});

it('clears a prior failure for a new run or a later successful reply', () => {
  const failed = { ...reply, id: 'failed', requestFailed: true };
  expect(
    chatVisualStatus(
      { ...snapshot.chat, status: 'running' },
      { ...snapshot, messages: [failed] },
    ),
  ).toBe('working');
  expect(
    chatVisualStatus(snapshot.chat, { ...snapshot, messages: [failed, reply] }),
  ).toBe('answered');
});

it('distinguishes recovery, cancelled work and unavailable lifecycle states from success', () => {
  expect(
    chatVisualStatus({ ...snapshot.chat, status: 'recovery' }, answered),
  ).toBe('attention');
  for (const status of ['creating', 'deleting'] as const)
    expect(chatVisualStatus({ ...snapshot.chat, status }, answered)).toBe(
      'idle',
    );
  expect(
    chatVisualStatus(snapshot.chat, {
      ...answered,
      settledRun: {
        id: 'cancelled',
        text: 'Partial',
        sequence: 1,
        state: 'aborted',
      },
    }),
  ).toBe('idle');
});

it('retains one dot across streaming, reply and failure updates with accessible labels', () => {
  render(<ChatStatusDot chat={snapshot.chat} />);
  const dot = screen.getByRole('img', { name: 'Ready when you are' });
  act(() =>
    useChatProjection.getState().applySnapshot({
      ...snapshot,
      activeRun: { id: 'run', text: '', sequence: 1 },
    }),
  );
  expect(screen.getByRole('img', { name: 'Agent is working' })).toBe(dot);
  expect(dot).toHaveAttribute('data-chat-state', 'working');
  act(() => useChatProjection.getState().applySnapshot(answered));
  expect(screen.getByRole('img', { name: 'Agent replied' })).toBe(dot);
  act(() =>
    useChatProjection.getState().applySnapshot({
      ...snapshot,
      messages: [{ ...reply, requestFailed: true }],
    }),
  );
  expect(screen.getByRole('img', { name: 'Agent request failed' })).toBe(dot);
  expect(dot).toHaveAttribute('data-chat-state', 'failed');
});

it('matches the header caption to a failed native request instead of claiming readiness', () => {
  render(
    <MemoryRouter>
      <ConversationHeader
        snapshot={{
          ...snapshot,
          messages: [{ ...reply, text: '', requestFailed: true }],
        }}
        chat={snapshot.chat}
        onSettings={() => undefined}
      />
    </MemoryRouter>,
  );
  expect(
    screen.getByRole('img', { name: 'Agent request failed' }),
  ).toHaveAttribute('data-chat-state', 'failed');
  expect(screen.getByText(/Agent request failed/)).toBeInTheDocument();
  expect(screen.queryByText(/Ready when you are/)).not.toBeInTheDocument();
});

it('validates the optional canonical failure marker while accepting legacy messages', () => {
  expect(messageValid(reply)).toBe(true);
  expect(messageValid({ ...reply, requestFailed: true })).toBe(true);
  expect(messageValid({ ...reply, requestFailed: 'true' })).toBe(false);
});
