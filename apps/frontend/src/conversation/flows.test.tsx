import { testConnectionTicket } from '../test/socket';
import { chooseOption } from '../test/select';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PendingMessage } from '@messenger/contracts';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthProvider';
import { ChatSettingsPanel } from '../settings/ChatSettingsPanel';
import { SettingsPage } from '../settings/SettingsPage';
import {
  useChatProjection,
  useDrafts,
  useModelCatalog,
  useNotices,
  usePreferences,
} from '../state/stores';
import { models, snapshot } from '../test/fixtures';
import { currentSocket, installTestSocket } from '../test/socket';
import { Composer } from './Composer';
import { ConnectionProvider } from './ConnectionProvider';
import { QueuedCard } from './QueuedCard';

const pending: PendingMessage = {
  id: 'pending-a',
  chatId: 'chat-a',
  position: 2,
  text: 'Queued original',
  attachments: [],
  revision: 1,
  state: 'pending',
  submissionId: 'submission-a',
  createdAt: 1,
};
beforeEach(() => {
  useChatProjection.getState().clear();
  useDrafts.getState().clear();
  usePreferences.getState().clear();
  useModelCatalog.getState().clear();
  useNotices.setState({ notices: [] });
  installTestSocket();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
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
          {
            status: 200,
            headers: { 'Content-Type': 'application/json', ETag: '"1"' },
          },
        ),
      ),
    ),
  );
});
function connected(ui: React.ReactNode) {
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

it('keeps application form preconditions local across New Chat preference loads and explicit conflict recovery', async () => {
  let latest = {
    version: 1,
    defaults: snapshot.chat.settings,
    busySendBehavior: 'queue' as 'queue' | 'steer',
  };
  const writes: RequestInit[] = [];
  const originalFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options: RequestInit = {}) => {
      if (url !== '/api/preferences') return originalFetch(url, options);
      if (options.method === 'PATCH') {
        writes.push(options);
        if (
          (options.headers as Record<string, string>)['If-Match'] !==
          `"${latest.version}"`
        )
          return Promise.resolve(
            new Response(
              JSON.stringify({ detail: 'Preferences changed elsewhere.' }),
              { status: 412, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        latest = {
          ...(JSON.parse(options.body as string) as Omit<
            typeof latest,
            'version'
          >),
          version: latest.version + 1,
        };
      }
      return Promise.resolve(
        new Response(JSON.stringify(latest), {
          headers: {
            'Content-Type': 'application/json',
            ETag: `"${latest.version}"`,
          },
        }),
      );
    }),
  );
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  await ready();
  await waitFor(() =>
    expect(screen.getByLabelText('Model')).toHaveAttribute(
      'data-value',
      'model-a',
    ),
  );
  await chooseOption(screen.getByLabelText('Thinking'), 'low');
  await chooseOption(screen.getByLabelText('Default send behavior'), 'steer');
  latest = {
    version: 2,
    defaults: { model: 'model-b', thinkingLevel: 'off', fastMode: false },
    busySendBehavior: 'queue',
  };
  await userEvent.click(
    screen.getByRole('button', { name: /New conversation/ }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Start a conversation',
  });
  await waitFor(() =>
    expect(within(dialog).getByLabelText('Model')).toHaveAttribute(
      'data-value',
      'model-b',
    ),
  );
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(usePreferences.getState().etag).toBe('"2"');
  await userEvent.click(
    screen.getByRole('button', { name: 'Save preferences' }),
  );
  await screen.findByText('Preferences changed elsewhere.');
  expect(writes).toHaveLength(1);
  expect((writes[0]?.headers as Record<string, string>)['If-Match']).toBe(
    '"1"',
  );
  expect(screen.getByLabelText('Model')).toHaveAttribute(
    'data-value',
    'model-a',
  );
  expect(screen.getByLabelText('Thinking')).toHaveAttribute(
    'data-value',
    'low',
  );
  expect(screen.getByLabelText('Default send behavior')).toHaveAttribute(
    'data-value',
    'steer',
  );
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Refresh latest values and models, keep my edits',
    }),
  );
  await screen.findByText(/Your edits are kept/);
  expect(writes).toHaveLength(1);
  expect(screen.getByLabelText('Thinking')).toHaveAttribute(
    'data-value',
    'low',
  );
  expect(screen.getByLabelText('Default send behavior')).toHaveAttribute(
    'data-value',
    'steer',
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Save preferences' }),
  );
  await screen.findByText('Preferences saved.');
  expect(writes).toHaveLength(2);
  expect((writes[1]?.headers as Record<string, string>)['If-Match']).toBe(
    '"2"',
  );
  expect(JSON.parse(writes[1]?.body as string)).toEqual({
    defaults: { model: 'model-a', thinkingLevel: 'low', fastMode: true },
    busySendBehavior: 'steer',
  });
  const save = screen.getByRole('button', { name: 'Save preferences' });
  expect(save).toBeDisabled();
  await userEvent.click(save);
  expect(writes).toHaveLength(2);
  expect(usePreferences.getState().etag).toBe('"3"');
});

it('initializes application settings from its own preference response when model loading overlaps an unrelated newer load', async () => {
  let finishModels!: (value: Response) => void;
  const modelRead = new Promise<Response>((resolve) => {
    finishModels = resolve;
  });
  let version = 1;
  const originalFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options: RequestInit = {}) => {
      if (url.startsWith('/api/models')) return modelRead;
      if (url === '/api/preferences')
        return Promise.resolve(
          new Response(
            JSON.stringify({
              version,
              defaults:
                version === 1
                  ? snapshot.chat.settings
                  : { model: 'model-b', thinkingLevel: 'off', fastMode: false },
              busySendBehavior: version === 1 ? 'queue' : 'steer',
            }),
            {
              headers: {
                'Content-Type': 'application/json',
                ETag: `"${version}"`,
              },
            },
          ),
        );
      return originalFetch(url, options);
    }),
  );
  render(
    <MemoryRouter>
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(usePreferences.getState().preferences?.version).toBe(1),
  );
  version = 2;
  await act(async () => {
    await usePreferences.getState().load();
  });
  await act(async () => {
    finishModels(
      new Response(JSON.stringify({ models }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await modelRead;
  });
  await waitFor(() =>
    expect(screen.getByLabelText('Model')).toHaveAttribute(
      'data-value',
      'model-a',
    ),
  );
  expect(screen.getByLabelText('Default send behavior')).toHaveAttribute(
    'data-value',
    'queue',
  );
  expect(usePreferences.getState().preferences?.version).toBe(2);
});
it('keeps exactly one composer and its draft when agent settings opens and closes repeatedly', async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/chat/chat-a']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  const composer = await screen.findByRole('textbox', {
    name: 'Message Research',
  });
  await ready();
  await user.type(composer, 'Keep this draft');
  for (let attempt = 0; attempt < 2; attempt++) {
    await user.click(screen.getByRole('button', { name: 'Agent settings' }));
    const settings = await screen.findByRole('dialog', {
      name: 'Agent settings',
    });
    await user.click(within(settings).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.querySelectorAll('form')).toHaveLength(1);
    });
    expect(screen.getByRole('textbox', { name: 'Message Research' })).toBe(
      composer,
    );
    expect(composer).toHaveValue('Keep this draft');
  }
});

it('preserves a second typed draft when the first message acknowledgement arrives', async () => {
  connected(<Composer snapshot={snapshot} />);
  await ready();
  const input = screen.getByRole('textbox', { name: 'Message Research' });
  await userEvent.type(input, 'First message');
  await userEvent.click(screen.getByRole('button', { name: /Send message/ }));
  const command = currentSocket().commands.find(
    (c) => c.type === 'conversation.message.send',
  );
  if (!command) throw new Error('Missing send command');
  await userEvent.clear(input);
  await userEvent.type(input, 'Second draft');
  act(() =>
    currentSocket().receive({
      type: 'command.result',
      commandId: command.commandId,
      ok: true,
      data: { messageId: 'accepted' },
    }),
  );
  expect(input).toHaveValue('Second draft');
});
it('retains text when delivery becomes unknown and does not replay a send after reconnect', async () => {
  connected(<Composer snapshot={snapshot} />);
  await ready();
  const input = screen.getByRole('textbox');
  await userEvent.type(input, 'Keep this');
  await userEvent.click(screen.getByRole('button', { name: /Send message/ }));
  act(() => currentSocket().close());
  await screen.findByRole('alert');
  expect(input).toHaveValue('Keep this');
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Delivery is unconfirmed',
  );
  expect(
    currentSocket().commands.filter(
      (c) => c.type === 'conversation.message.send',
    ),
  ).toHaveLength(1);
});
it('keeps a correction when the dispatcher wins an edit race, and uses the same revision and position', async () => {
  connected(<QueuedCard message={pending} canSteer />);
  await ready();
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  const input = screen.getByLabelText('Correction');
  await userEvent.clear(input);
  await userEvent.type(input, 'Correction retained');
  await userEvent.click(
    screen.getByRole('button', { name: 'Save correction' }),
  );
  const command = currentSocket().commands.find(
    (c) => c.type === 'conversation.message.editQueued',
  );
  expect(command).toMatchObject({
    revision: 1,
    messageId: 'pending-a',
    text: 'Correction retained',
  });
  if (!command) throw new Error('Missing edit command');
  act(() =>
    currentSocket().receive({
      type: 'command.result',
      commandId: command.commandId,
      ok: false,
      error: {
        type: 'about:blank',
        title: 'Conflict',
        detail: 'This message is already submitting.',
        status: 409,
        code: 'CONFLICT',
        correlationId: 'test',
      },
    }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'already submitting',
  );
  expect(input).toHaveValue('Correction retained');
  expect(screen.getByText('Queued · 2')).toBeVisible();
});
it('does not offer edit or cancel for claimed messages and exposes explicit unknown recovery', async () => {
  const view = connected(
    <QueuedCard message={{ ...pending, state: 'submitting' }} canSteer />,
  );
  await ready();
  expect(
    screen.queryByRole('button', { name: 'Edit' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Cancel' }),
  ).not.toBeInTheDocument();
  view.rerender(
    <AuthProvider>
      <ConnectionProvider>
        <QueuedCard message={{ ...pending, state: 'unknown' }} canSteer />
      </ConnectionProvider>
    </AuthProvider>,
  );
  expect(
    screen.getByRole('button', { name: 'Retry with receipt check' }),
  ).toBeVisible();
  expect(screen.getByText(/original content is retained/)).toBeVisible();
});
it('supports navigation and keyboard sending while keeping a draft per conversation', async () => {
  render(
    <MemoryRouter initialEntries={['/chat/chat-a']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  await ready();
  const first = await screen.findByRole('textbox', {
    name: 'Message Research',
  });
  await userEvent.type(first, 'Route-stable draft');
  await userEvent.click(screen.getByRole('link', { name: /Writing/ }));
  const second = await screen.findByRole('textbox', {
    name: 'Message Writing',
  });
  await userEvent.type(second, 'Independent draft');
  await userEvent.click(screen.getByRole('link', { name: /Research/ }));
  expect(
    await screen.findByRole('textbox', { name: 'Message Research' }),
  ).toHaveValue('Route-stable draft');
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message Research' }), {
    key: 'Enter',
    ctrlKey: true,
  });
  expect(
    currentSocket().commands.some(
      (c) =>
        c.type === 'conversation.message.send' &&
        c.text === 'Route-stable draft',
    ),
  ).toBe(true);
});
it('asks for a busy settings policy and preserves editing until a choice is made', async () => {
  connected(
    <ChatSettingsPanel
      snapshot={{
        ...snapshot,
        activeRun: { id: 'run', text: 'Working', sequence: 1 },
      }}
      onClose={() => undefined}
    />,
  );
  await ready();
  await waitFor(() =>
    expect(screen.getByLabelText('Model')).toHaveAttribute(
      'data-value',
      'model-a',
    ),
  );
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await chooseOption(screen.getByLabelText('Thinking'), 'low');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(
    screen.getByRole('button', { name: 'Apply when all work is idle' }),
  ).toBeVisible();
  expect(
    screen.getByRole('button', {
      name: 'Cancel active and queued work, then apply',
    }),
  ).toBeVisible();
  await userEvent.click(
    screen.getByRole('button', { name: 'Continue editing' }),
  );
  expect(screen.getByLabelText('Conversation name')).toHaveValue('Research');
  expect(screen.getByLabelText('Thinking')).toHaveAttribute(
    'data-value',
    'low',
  );
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});
it('sends exact ETag preconditions and selected policy for a busy settings save', async () => {
  connected(
    <ChatSettingsPanel
      snapshot={{
        ...snapshot,
        activeRun: { id: 'run', text: 'Working', sequence: 1 },
      }}
      onClose={() => undefined}
    />,
  );
  await ready();
  await waitFor(() =>
    expect(screen.getByLabelText('Model')).toHaveAttribute(
      'data-value',
      'model-a',
    ),
  );
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await chooseOption(screen.getByLabelText('Thinking'), 'low');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await userEvent.click(
    screen.getByRole('button', { name: 'Apply when all work is idle' }),
  );
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/chats/chat-a/settings',
      expect.objectContaining({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'If-Match': '"1"' },
        body: JSON.stringify({
          settings: { ...snapshot.chat.settings, thinkingLevel: 'low' },
          policy: 'when-idle',
        }),
      }),
    ),
  );
});
