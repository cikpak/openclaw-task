import { testConnectionTicket } from '../test/socket';

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthProvider';
import { commandId } from '../lib/api';

import {
  useChatProjection,
  useDrafts,
  useModelCatalog,
  usePreferences,
} from '../state/stores';
import { models, snapshot } from '../test/fixtures';
import { currentSocket, installTestSocket } from '../test/socket';
import { Composer } from './Composer';

import { ConnectionProvider, useConversation } from './ConnectionProvider';

function response(data: unknown, etag = '"1"', status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ETag: etag },
  });
}
function defaultFetch(url: string) {
  return Promise.resolve(
    response(
      url === '/api/connection-tickets'
        ? testConnectionTicket()
        : url === '/api/session'
          ? { authenticated: true, username: 'owner' }
          : url === '/api/chats'
            ? {
                chats: [
                  snapshot.chat,
                  { ...snapshot.chat, id: 'chat-b', name: 'Writing' },
                ],
              }
            : url === '/api/chats/chat-a'
              ? snapshot.chat
              : url.startsWith('/api/models')
                ? { models }
                : url.includes('/settings')
                  ? {
                      effective: snapshot.chat.settings,
                      pending: null,
                      version: 1,
                    }
                  : {
                      version: 1,
                      busySendBehavior: 'queue',
                      defaults: snapshot.chat.settings,
                    },
    ),
  );
}
beforeEach(() => {
  useChatProjection.getState().clear();
  useDrafts.getState().clear();
  usePreferences.getState().clear();
  useModelCatalog.getState().clear();
  installTestSocket();
  vi.stubGlobal('fetch', vi.fn(defaultFetch));
});
function connected(ui: ReactNode) {
  return render(
    <AuthProvider>
      <ConnectionProvider>{ui}</ConnectionProvider>
    </AuthProvider>,
  );
}
async function ready() {
  await waitFor(() =>
    expect(useChatProjection.getState().connection).toBe('ready'),
  );
}
it('accepts chat A snapshot while B emits events without issuing another snapshot request', async () => {
  function Probe() {
    const send = useConversation();
    return (
      <button
        type="button"
        onClick={() => {
          void send({
            type: 'conversation.snapshot.request',
            commandId: commandId(),
            chatId: 'fresh-a',
          });
        }}
      >
        Load A
      </button>
    );
  }
  connected(<Probe />);
  await ready();
  const socket = currentSocket();
  socket.autoSnapshots = false;
  await userEvent.click(screen.getByRole('button', { name: 'Load A' }));
  const command = socket.commands.at(-1);
  if (!command) throw new Error('Missing request');
  const count = socket.commands.length;
  act(() => {
    socket.receive({
      type: 'conversation.run.text',
      generation: 'test',
      sequence: 1,
      chatId: 'chat-b',
      runId: 'b-run',
      runSequence: 1,
      text: 'Busy',
      replace: false,
    });
    socket.receive({
      type: 'command.result',
      commandId: command.commandId,
      ok: true,
      data: {
        snapshot: {
          ...snapshot,
          chat: { ...snapshot.chat, id: 'fresh-a', name: 'Fresh A' },
        },
      },
    });
  });
  expect(useChatProjection.getState().snapshots['fresh-a']?.chat.name).toBe(
    'Fresh A',
  );
  expect(socket.commands).toHaveLength(count);
});
it('keeps a racing correction visible after its queue card disappears, navigation and acknowledgement', async () => {
  render(
    <MemoryRouter initialEntries={['/chat/chat-a']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  await ready();
  act(() =>
    useChatProjection.getState().applySnapshot({
      ...snapshot,
      pending: [
        {
          id: 'pending',
          chatId: 'chat-a',
          position: 1,
          text: 'Original',
          attachments: [],
          revision: 1,
          state: 'pending',
          submissionId: 'submission',
          createdAt: 1,
        },
      ],
    }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  const correction = screen.getByLabelText('Correction');
  await userEvent.clear(correction);
  await userEvent.type(correction, 'Keep this correction');
  await userEvent.click(
    screen.getByRole('button', { name: 'Save correction' }),
  );
  const command = currentSocket().commands.find(
    (c) => c.type === 'conversation.message.editQueued',
  );
  if (!command) throw new Error('Missing edit');
  act(() => {
    currentSocket().receive({
      type: 'conversation.snapshot',
      generation: 'test',
      sequence: 1,
      snapshot: { ...snapshot, pending: [] },
    });
    currentSocket().receive({
      type: 'command.result',
      commandId: command.commandId,
      ok: false,
      error: {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Already submitting.',
        code: 'CONFLICT',
        correlationId: 'test',
      },
    });
  });
  expect(await screen.findByLabelText('Retained correction')).toHaveValue(
    'Keep this correction',
  );
  await userEvent.click(
    screen.getByRole('link', { name: /Back to conversations/ }),
  );
  await userEvent.click(screen.getByRole('link', { name: /Research/ }));
  expect(await screen.findByLabelText('Retained correction')).toHaveValue(
    'Keep this correction',
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Message Research' }),
    'Existing',
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Add correction to draft' }),
  );
  expect(screen.getByRole('textbox', { name: 'Message Research' })).toHaveValue(
    'Existing\n\nKeep this correction',
  );
});
it('allows durable Queue acceptance when Gateway is unavailable but transport is open', async () => {
  connected(<Composer snapshot={snapshot} />);
  await ready();
  act(() =>
    currentSocket().receive({
      type: 'connection.state',
      generation: 'test',
      sequence: 1,
      state: 'unavailable',
    }),
  );
  await userEvent.type(screen.getByRole('textbox'), 'Wait safely');
  expect(screen.getByRole('button', { name: /Send message/ })).toBeEnabled();
  await userEvent.click(screen.getByRole('button', { name: /Send message/ }));
  expect(
    currentSocket().commands.some(
      (command) =>
        command.type === 'conversation.message.send' &&
        command.behavior === 'queue',
    ),
  ).toBe(true);
  expect(screen.getByText(/Queued messages are saved/)).toBeVisible();
});
it('returns to the conversation catalog after confirmed deletion', async () => {
  render(
    <MemoryRouter initialEntries={['/chat/chat-a']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  await ready();
  expect(
    await screen.findByRole('textbox', { name: 'Message Research' }),
  ).toBeVisible();
  act(() =>
    currentSocket().receive({
      type: 'conversation.deleted',
      generation: 'test',
      sequence: 1,
      chatId: 'chat-a',
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('textbox', { name: 'Message Research' }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole('button', { name: /New conversation/ }),
  ).toBeVisible();
});
