import { chooseOption } from '../test/select';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthProvider';
import { commandId } from '../lib/api';
import { ChatSettingsPanel } from '../settings/ChatSettingsPanel';
import {
  useChatProjection,
  useDrafts,
  useModelCatalog,
  usePreferences,
} from '../state/stores';
import { models, snapshot } from '../test/fixtures';
import { currentSocket, installTestSocket, TestSocket } from '../test/socket';
import { Composer } from './Composer';
import { QueuedCard } from './QueuedCard';
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
      url === '/api/session'
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

it('waits for fresh settings before enabling deletion and uses its ETag', async () => {
  let completeRead!: (value: Response) => void;
  const initialRead = new Promise<Response>((resolve) => {
    completeRead = resolve;
  });
  let completeDeletion!: (value: Response) => void;
  const deletionResponse = new Promise<Response>((resolve) => {
    completeDeletion = resolve;
  });
  const fetch = vi.fn((url: string, options: RequestInit = {}) => {
    if (url === '/api/chats/chat-a' && !options.method) return initialRead;
    if (options.method === 'DELETE') return deletionResponse;
    return defaultFetch(url);
  });
  vi.stubGlobal('fetch', fetch);
  const close = vi.fn();
  connected(<ChatSettingsPanel snapshot={snapshot} onClose={close} />);
  await ready();
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith('/api/chats/chat-a', expect.anything()),
  );
  const deletion = screen.getByRole('button', {
    name: 'Delete conversation…',
  });
  expect(deletion).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  expect(screen.getByText('Loading latest agent settings…')).toBeVisible();
  await userEvent.click(deletion);
  expect(
    screen.queryByRole('button', { name: 'Confirm deletion' }),
  ).not.toBeInTheDocument();
  expect(
    fetch.mock.calls.some(([, options]) => options?.method === 'DELETE'),
  ).toBe(false);
  await act(async () => {
    completeRead(response({ ...snapshot.chat, version: 4 }, '"4"'));
    await initialRead;
  });
  await waitFor(() => expect(deletion).toBeEnabled());
  await userEvent.click(deletion);
  await userEvent.click(
    screen.getByRole('button', { name: 'Confirm deletion' }),
  );
  expect(
    screen.getByRole('button', { name: 'Confirm deletion' }),
  ).toBeDisabled();
  await act(async () => {
    completeDeletion(new Response(null, { status: 204 }));
    await deletionResponse;
  });
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(fetch).toHaveBeenCalledWith(
    '/api/chats/chat-a',
    expect.objectContaining({
      method: 'DELETE',
      headers: { 'If-Match': '"4"' },
    }),
  );
});

it('permits explicit deletion with a fresh local ETag when Gateway model discovery fails', async () => {
  let settingsReads = 0;
  let deleteRequests = 0;
  const fetch = vi.fn((url: string, options: RequestInit = {}) => {
    if (url.startsWith('/api/models'))
      return Promise.resolve(
        response({ detail: 'Gateway models unavailable' }, '"1"', 503),
      );
    if (url === '/api/chats/chat-a' && !options.method) {
      const version = settingsReads++ === 0 ? 6 : 7;
      return Promise.resolve(
        response({ ...snapshot.chat, version }, `"${version}"`),
      );
    }
    if (options.method === 'DELETE') {
      deleteRequests++;
      return Promise.resolve(
        deleteRequests === 1
          ? response(
              { detail: 'This resource changed. Reload before saving.' },
              '"7"',
              412,
            )
          : new Response(null, { status: 204 }),
      );
    }
    if (url === '/api/chats/chat-a')
      return Promise.resolve(response({ ...snapshot.chat, version: 7 }, '"7"'));
    return defaultFetch(url);
  });
  vi.stubGlobal('fetch', fetch);
  connected(<ChatSettingsPanel snapshot={snapshot} onClose={vi.fn()} />);
  await screen.findByText('Gateway models unavailable');
  const deletion = screen.getByRole('button', { name: 'Delete conversation…' });
  await waitFor(() => expect(deletion).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await userEvent.clear(
    screen.getByRole('textbox', { name: 'Conversation name' }),
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Conversation name' }),
    'Retained local edit',
  );
  await userEvent.click(deletion);
  await userEvent.click(
    screen.getByRole('button', { name: 'Confirm deletion' }),
  );
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/chats/chat-a',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'If-Match': '"6"' },
      }),
    ),
  );
  await screen.findByText('This resource changed. Reload before saving.');
  expect(deleteRequests).toBe(1);
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Refresh latest values and models, keep my edits',
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Confirm deletion' }),
    ).toBeEnabled(),
  );
  expect(deleteRequests).toBe(1);
  expect(
    screen.getByRole('textbox', { name: 'Conversation name' }),
  ).toHaveValue('Retained local edit');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await userEvent.click(
    screen.getByRole('button', { name: 'Confirm deletion' }),
  );
  await waitFor(() => expect(deleteRequests).toBe(2));
  expect(fetch).toHaveBeenCalledWith(
    '/api/chats/chat-a',
    expect.objectContaining({
      method: 'DELETE',
      headers: { 'If-Match': '"7"' },
    }),
  );
});

it('keeps mutation and recovery controls blocked after initial settings failure until explicit refresh succeeds', async () => {
  let reads = 0;
  const fetch = vi.fn((url: string, options: RequestInit = {}) => {
    if (url === '/api/chats/chat-a' && !options.method) {
      reads++;
      return Promise.resolve(
        reads === 1
          ? response({ detail: 'Latest settings unavailable' }, '"1"', 503)
          : response({ ...snapshot.chat, version: 5 }, '"5"'),
      );
    }
    return defaultFetch(url);
  });
  vi.stubGlobal('fetch', fetch);
  connected(
    <ChatSettingsPanel
      snapshot={{
        ...snapshot,
        pendingSettings: {
          id: 'settings-operation',
          settings: snapshot.chat.settings,
          policy: 'when-idle',
          status: 'unknown',
        },
      }}
      onClose={vi.fn()}
    />,
  );
  await screen.findByText('Latest settings unavailable');
  expect(
    screen.getByRole('button', { name: 'Retry pending change' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Discard pending change' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Delete conversation…' }),
  ).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Refresh latest values and models, keep my edits',
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Retry pending change' }),
    ).toBeEnabled(),
  );
  expect(
    screen.getByRole('button', { name: 'Delete conversation…' }),
  ).toBeEnabled();
  expect(reads).toBe(2);
  expect(fetch.mock.calls.some(([, options]) => !!options?.method)).toBe(false);
});

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
        (command) => command.type === 'conversation.snapshot.request',
      )
      .every((command) => command.chatId !== undefined),
  ).toBe(true);
});
it('accepts one legitimate projected snapshot with worst-case JSON control escaping within the bounded frame budget', async () => {
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
it('refreshes ETags and capabilities after conflict while preserving settings form edits', async () => {
  let updated = false;
  const writes: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options: RequestInit = {}) => {
      if (url === '/api/chats/chat-a/settings' && options.method === 'PATCH') {
        writes.push(options);
        if (writes.length === 1)
          return Promise.resolve(
            response({ detail: 'Settings changed elsewhere.' }, '"2"', 412),
          );
        return Promise.resolve(
          response(
            {
              effective: {
                model: 'model-b',
                thinkingLevel: 'off',
                fastMode: false,
              },
              pending: null,
              version: 3,
            },
            '"3"',
          ),
        );
      }
      if (url === '/api/chats/chat-a/settings') {
        return Promise.resolve(
          response(
            {
              effective: snapshot.chat.settings,
              pending: null,
              version: updated ? 2 : 1,
            },
            updated ? '"2"' : '"1"',
          ),
        );
      }
      if (url === '/api/chats/chat-a')
        return Promise.resolve(
          response({ ...snapshot.chat, version: 2 }, '"2"'),
        );
      return defaultFetch(url);
    }),
  );
  connected(
    <ChatSettingsPanel snapshot={snapshot} onClose={() => undefined} />,
  );
  await ready();
  await waitFor(() =>
    expect(screen.getByLabelText('Model')).toHaveAttribute(
      'data-value',
      'model-a',
    ),
  );
  await chooseOption(screen.getByLabelText('Model'), 'model-b');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Settings changed elsewhere',
  );
  updated = true;
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Refresh latest values and models, keep my edits',
    }),
  );
  await screen.findByText(/Your edits are kept/);
  expect(screen.getByLabelText('Model')).toHaveAttribute(
    'data-value',
    'model-b',
  );
  expect(screen.getByLabelText('Thinking')).toHaveAttribute(
    'data-value',
    'off',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]?.headers).toEqual({
    'Content-Type': 'application/json',
    'If-Match': '"2"',
  });
  expect(writes[1]?.body).toBe(
    JSON.stringify({
      settings: { model: 'model-b', thinkingLevel: 'off', fastMode: false },
      policy: 'when-idle',
    }),
  );
});
