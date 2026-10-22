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
import { Composer } from './Composer';

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
it('does not resend a message when the websocket actually reconnects', async () => {
  connected(<Composer snapshot={snapshot} />);
  await ready();
  await userEvent.type(screen.getByRole('textbox'), 'Unconfirmed');
  await userEvent.click(screen.getByRole('button', { name: /Send message/ }));
  const first = currentSocket();
  act(() => first.close());
  await screen.findByRole('alert');
  await waitFor(() => expect(TestSocket.instances).toHaveLength(2), {
    timeout: 2500,
  });
  expect(
    first.commands.filter(
      (command) => command.type === 'conversation.message.send',
    ),
  ).toHaveLength(1);
  expect(
    currentSocket().commands.some(
      (command) => command.type === 'conversation.message.send',
    ),
  ).toBe(false);
  expect(screen.getByRole('textbox')).toHaveValue('Unconfirmed');
});
it('loads bounded maximum tool snapshots per chat instead of dropping a large aggregate frame', async () => {
  const snapshots = Array.from({ length: 10 }, (_, index) => ({
    ...snapshot,
    chat: { ...snapshot.chat, id: `chat-${index}` },
    tools: Array.from({ length: 100 }, (_, tool) => ({
      id: `tool-${tool}`,
      name: 'read',
      status: 'completed' as const,
      parameters: 'p'.repeat(4096),
      output: 'o'.repeat(8192),
    })),
  }));
  expect(JSON.stringify({ snapshots }).length).toBeGreaterThan(
    10 * 1024 * 1024,
  );
  TestSocket.snapshots = snapshots;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url === '/api/chats'
        ? Promise.resolve(
            response({ chats: snapshots.map((item) => item.chat) }),
          )
        : defaultFetch(url),
    ),
  );
  connected(<div>Workspace</div>);
  await ready();
  await waitFor(
    () =>
      expect(Object.keys(useChatProjection.getState().snapshots)).toHaveLength(
        10,
      ),
    { timeout: 2500 },
  );
  expect(
    currentSocket()
      .commands.filter(
        (command) => command.type === 'conversation.recent.request',
      )
      .every((command) => command.chatId !== undefined),
  ).toBe(true);
});
it('reassembles a complete projected snapshot with worst-case JSON escaping from bounded transport fragments', async () => {
  const large = {
    ...snapshot,
    activeRun: {
      id: 'run',
      sequence: 1,
      text: '\u0000'.repeat(256 * 1024),
      truncated: true,
    },
    pending: Array.from({ length: 41 }, (_, index) => ({
      id: `pending-${index}`,
      chatId: 'chat-a',
      position: index + 1,
      text: '\u0000'.repeat(32000),
      attachments: [],
      revision: 1,
      state: index < 20 ? ('pending' as const) : ('unknown' as const),
      submissionId: `submission-${index}`,
      createdAt: 1,
    })),
    tools: Array.from({ length: 100 }, (_, index) => ({
      id: `tool-${index}`,
      name: 'read',
      status: 'completed' as const,
      parameters: '\u0000'.repeat(4096),
      output: '\u0000'.repeat(8192),
    })),
    hiddenPendingCount: 7,
  };
  const encoded = JSON.stringify(large);
  expect(encoded.length).toBeGreaterThan(16 * 1024 * 1024);
  expect(encoded.length).toBeLessThan(32 * 1024 * 1024);
  TestSocket.snapshots = [large];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url === '/api/chats'
        ? Promise.resolve(response({ chats: [snapshot.chat] }))
        : defaultFetch(url),
    ),
  );
  connected(<div>Workspace</div>);
  await ready();
  await waitFor(
    () =>
      expect(
        useChatProjection.getState().snapshots['chat-a']?.pending,
      ).toHaveLength(41),
    { timeout: 2500 },
  );
  expect(
    useChatProjection.getState().snapshots['chat-a']?.hiddenPendingCount,
  ).toBe(7);
  expect(
    useChatProjection.getState().snapshots['chat-a']?.activeRun?.truncated,
  ).toBe(true);
});
it('announces bounded preview and hidden recovery windows while preserving controls for visible entries', async () => {
  render(
    <MemoryRouter initialEntries={['/chat/chat-a']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  await ready();
  await screen.findByRole('textbox', { name: 'Message Research' });
  act(() =>
    currentSocket().receive({
      type: 'conversation.snapshot',
      generation: 'test',
      sequence: 1,
      snapshot: {
        ...snapshot,
        activeRun: {
          id: 'run',
          text: 'Bounded preview',
          sequence: 1,
          truncated: true,
        },
        hiddenPendingCount: 7,
        pending: [
          {
            id: 'unknown',
            chatId: 'chat-a',
            position: 1,
            text: 'Recoverable',
            attachments: [],
            revision: 1,
            state: 'unknown',
            submissionId: 'submission',
            createdAt: 1,
          },
        ],
      },
    }),
  );
  expect(screen.getByText(/Live preview is limited/)).toBeVisible();
  expect(screen.getByText(/7 more messages remain stored/)).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Retry with receipt check' }),
  ).toBeVisible();
  act(() =>
    currentSocket().receive({
      type: 'conversation.run.text',
      generation: 'test',
      sequence: 2,
      chatId: 'chat-a',
      runId: 'run',
      text: 'Short replacement',
      runSequence: 2,
      replace: true,
      truncated: false,
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByText(/Live preview is limited/),
    ).not.toBeInTheDocument(),
  );
});
