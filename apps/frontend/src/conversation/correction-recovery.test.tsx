import { testConnectionTicket } from '../test/socket';

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthProvider';

import {
  useChatProjection,
  useDrafts,
  useModelCatalog,
  usePreferences,
} from '../state/stores';
import { models, snapshot } from '../test/fixtures';
import { currentSocket, installTestSocket, TestSocket } from '../test/socket';

import { QueuedCard } from './QueuedCard';
import { ConnectionProvider } from './ConnectionProvider';

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
it('resynchronizes at 100 tombstones and ignores callbacks from the retired socket', async () => {
  connected(<div>Workspace</div>);
  await ready();
  const old = currentSocket();
  act(() => {
    for (let index = 1; index <= 100; index++)
      old.receive({
        type: 'conversation.deleted',
        generation: 'test',
        sequence: index,
        chatId: `retired-${index}`,
      });
  });
  expect(old.readyState).toBe(3);
  expect(Object.keys(useChatProjection.getState().deletedChats)).toHaveLength(
    100,
  );
  act(() =>
    old.receive({
      type: 'conversation.deleted',
      generation: 'test',
      sequence: 101,
      chatId: 'late',
    }),
  );
  expect(Object.keys(useChatProjection.getState().deletedChats)).toHaveLength(
    100,
  );
  await waitFor(() => expect(TestSocket.instances).toHaveLength(2), {
    timeout: 2500,
  });
  await waitFor(() =>
    expect(Object.keys(useChatProjection.getState().deletedChats)).toHaveLength(
      0,
    ),
  );
  act(() => {
    old.readyState = 1;
    old.receive({
      type: 'conversation.snapshot',
      generation: 'test',
      sequence: 999,
      snapshot: { ...snapshot, chat: { ...snapshot.chat, id: 'retired-1' } },
    });
  });
  expect(useChatProjection.getState().chats['retired-1']).toBeUndefined();
});
it('does not carry an outstanding abort or its late error into another chat route', async () => {
  render(
    <MemoryRouter initialEntries={['/chat/chat-a']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  await ready();
  await screen.findByRole('textbox', { name: 'Message Research' });
  const socket = currentSocket();
  socket.autoSnapshots = false;
  act(() => {
    useChatProjection.getState().applySnapshot({
      ...snapshot,
      activeRun: { id: 'run-a', text: 'A working', sequence: 1 },
    });
    useChatProjection.getState().applySnapshot({
      ...snapshot,
      chat: { ...snapshot.chat, id: 'chat-b', name: 'Writing' },
      activeRun: { id: 'run-b', text: 'B working', sequence: 1 },
    });
  });
  await userEvent.click(screen.getByRole('button', { name: 'Stop this run' }));
  const abort = socket.commands.find(
    (command) => command.type === 'conversation.run.abort',
  );
  if (!abort) throw new Error('Missing abort');
  await userEvent.click(screen.getByRole('link', { name: /Writing/ }));
  expect(
    await screen.findByRole('textbox', { name: 'Message Writing' }),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Stop this run' })).toBeEnabled();
  await act(async () => {
    socket.receive({
      type: 'command.result',
      commandId: abort.commandId,
      ok: false,
      error: {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Old chat abort failed.',
        code: 'CONFLICT',
        correlationId: 'test',
      },
    });
    await Promise.resolve();
  });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('uses the queued revision from the start of editing and requires an explicit conflict rebase', async () => {
  const message = {
    id: 'pending',
    chatId: 'chat-a',
    position: 1,
    text: 'Original',
    attachments: [],
    revision: 1,
    state: 'pending' as const,
    submissionId: 'submission',
    createdAt: 1,
  };
  const view = connected(<QueuedCard message={message} canSteer />);
  await ready();
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await userEvent.clear(screen.getByLabelText('Correction'));
  await userEvent.type(screen.getByLabelText('Correction'), 'My correction');
  view.rerender(
    <AuthProvider>
      <ConnectionProvider>
        <QueuedCard
          message={{ ...message, text: 'Changed elsewhere', revision: 2 }}
          canSteer
        />
      </ConnectionProvider>
    </AuthProvider>,
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Save correction' }),
  );
  const first = currentSocket()
    .commands.filter(
      (command) => command.type === 'conversation.message.editQueued',
    )
    .at(-1);
  expect(first).toMatchObject({ revision: 1, text: 'My correction' });
  if (!first) throw new Error('Missing edit');
  act(() =>
    currentSocket().receive({
      type: 'command.result',
      commandId: first.commandId,
      ok: false,
      error: {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Queued message changed.',
        code: 'CONFLICT',
        correlationId: 'test',
      },
    }),
  );
  await screen.findByRole('alert');
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Use latest revision, keep my correction',
    }),
  );
  expect(screen.getByLabelText('Correction')).toHaveValue('My correction');
  await userEvent.click(
    screen.getByRole('button', { name: 'Save correction' }),
  );
  const second = currentSocket()
    .commands.filter(
      (command) => command.type === 'conversation.message.editQueued',
    )
    .at(-1);
  expect(second).toMatchObject({ revision: 2, text: 'My correction' });
  if (!second) throw new Error('Missing rebased edit');
  act(() =>
    currentSocket().receive({
      type: 'command.result',
      commandId: second.commandId,
      ok: true,
      data: { messageId: 'pending' },
    }),
  );
});
