import { testConnectionTicket } from '../test/socket';
import { chooseOption } from '../test/select';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatSummary } from '@messenger/contracts';
import { AuthProvider } from '../auth/AuthProvider';
import { ConnectionProvider } from '../conversation/ConnectionProvider';
import { useChatProjection, useModelCatalog } from '../state/stores';
import { models, snapshot } from '../test/fixtures';
import { installTestSocket, TestSocket } from '../test/socket';
import { ChatSettingsPanel } from './ChatSettingsPanel';

function response(data: unknown, version = 1, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ETag: `"${version}"` },
  });
}
beforeEach(() => {
  useChatProjection.getState().clear();
  useModelCatalog.getState().clear();
  installTestSocket();
});
function ProjectedPanel() {
  const current = useChatProjection((state) => state.snapshots['chat-a']);
  return <ChatSettingsPanel snapshot={current ?? snapshot} onClose={vi.fn()} />;
}
function fixture() {
  let latest: ChatSummary = snapshot.chat;
  let finishChat!: (value: Response) => void;
  let finishSettings!: (value: Response) => void;
  const chatRead = new Promise<Response>((resolve) => {
    finishChat = resolve;
  });
  const settingsRead = new Promise<Response>((resolve) => {
    finishSettings = resolve;
  });
  let initial = true;
  const writes: { url: string; options: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options: RequestInit = {}) => {
      if (url === '/api/connection-tickets')
        return Promise.resolve(
          new Response(JSON.stringify(testConnectionTicket())),
        );
      if (options.method === 'PATCH') {
        writes.push({ url, options });
        if (
          (options.headers as Record<string, string>)['If-Match'] !==
          `"${latest.version}"`
        )
          return Promise.resolve(
            response(
              { detail: 'This resource changed. Reload before saving.' },
              latest.version,
              412,
            ),
          );
        if (url === '/api/chats/chat-a') {
          const input = JSON.parse(options.body as string) as { name: string };
          latest = { ...latest, name: input.name, version: latest.version + 1 };
          return Promise.resolve(response(latest, latest.version));
        }
        return Promise.resolve(
          response(
            {
              effective: latest.settings,
              pending: null,
              version: latest.version,
            },
            latest.version,
          ),
        );
      }
      if (url === '/api/chats/chat-a')
        return initial
          ? chatRead
          : Promise.resolve(response(latest, latest.version));
      if (url === '/api/chats/chat-a/settings')
        return initial
          ? settingsRead
          : Promise.resolve(
              response(
                {
                  effective: latest.settings,
                  pending: null,
                  version: latest.version,
                },
                latest.version,
              ),
            );
      return Promise.resolve(
        response(
          url === '/api/session'
            ? { authenticated: true }
            : url === '/api/chats'
              ? { chats: [snapshot.chat] }
              : { models },
        ),
      );
    }),
  );
  render(
    <AuthProvider>
      <ConnectionProvider>
        <ProjectedPanel />
      </ConnectionProvider>
    </AuthProvider>,
  );
  return {
    writes,
    async completeInitial(this: void, name: string) {
      await waitFor(() =>
        expect(useChatProjection.getState().snapshots['chat-a']).toBeDefined(),
      );
      latest = {
        ...snapshot.chat,
        name,
        version: 2,
        settings: {
          ...snapshot.chat.settings,
          thinkingLevel: 'low',
          fastMode: false,
        },
      };
      TestSocket.snapshots = [{ ...snapshot, chat: latest }];
      act(() =>
        useChatProjection
          .getState()
          .applySnapshot({ ...snapshot, chat: latest }),
      );
      await act(async () => {
        finishChat(response(latest, 2));
        finishSettings(
          response(
            { effective: latest.settings, pending: null, version: 2 },
            2,
          ),
        );
        await Promise.all([chatRead, settingsRead]);
      });
      initial = false;
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Save changes' }),
        ).toBeDisabled(),
      );
      expect(screen.getByLabelText('Conversation name')).toHaveValue(name);
      expect(screen.getByLabelText('Thinking')).toHaveAttribute(
        'data-value',
        'low',
      );
      expect(
        screen.getByRole('button', { name: 'Delete conversation…' }),
      ).toBeEnabled();
    },
    renameElsewhere(this: void, name: string) {
      latest = { ...latest, name, version: latest.version + 1 };
      act(() =>
        useChatProjection
          .getState()
          .applySnapshot({ ...snapshot, chat: latest }),
      );
    },
  };
}

it.each(['Renamed by another tab', 'Automatic generated title'])(
  'pairs the initial name and settings with the authoritative version after %s',
  async (name) => {
    const { writes, completeInitial } = fixture();
    expect(
      screen.getByRole('button', { name: 'Delete conversation…' }),
    ).toBeDisabled();
    await completeInitial(name);
    expect(screen.getByLabelText('Thinking')).toHaveAttribute(
      'data-value',
      'low',
    );
    expect(screen.getByLabelText('Speed')).toHaveAttribute(
      'data-value',
      'standard',
    );
    await chooseOption(screen.getByLabelText('Thinking'), 'high');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes.map((write) => write.url)).toEqual([
      '/api/chats/chat-a/settings',
    ]);
    expect(
      (writes[0]?.options.headers as Record<string, string>)['If-Match'],
    ).toBe('"2"');
    expect(screen.getByLabelText('Conversation name')).toHaveValue(name);
    expect(JSON.parse(writes[0]?.options.body as string)).toEqual({
      settings: { model: 'model-a', thinkingLevel: 'high', fastMode: false },
      policy: 'when-idle',
    });
  },
);

it('sends a genuinely edited name with its paired initial version before the settings change', async () => {
  const { writes, completeInitial } = fixture();
  await completeInitial('Other tab title');
  await userEvent.clear(screen.getByLabelText('Conversation name'));
  await userEvent.type(screen.getByLabelText('Conversation name'), 'My title');
  await chooseOption(screen.getByLabelText('Thinking'), 'high');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[0]?.options.body).toBe(JSON.stringify({ name: 'My title' }));
  expect(
    (writes[0]?.options.headers as Record<string, string>)['If-Match'],
  ).toBe('"2"');
  expect(
    (writes[1]?.options.headers as Record<string, string>)['If-Match'],
  ).toBe('"3"');
});

it('retains actual edits after a later rename conflicts and requires explicit refresh and resave', async () => {
  const { writes, completeInitial, renameElsewhere } = fixture();
  await completeInitial('Initial current title');
  await userEvent.clear(screen.getByLabelText('Conversation name'));
  await userEvent.type(
    screen.getByLabelText('Conversation name'),
    'My edited title',
  );
  await chooseOption(screen.getByLabelText('Thinking'), 'high');
  renameElsewhere('Later rename');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await screen.findByText('This resource changed. Reload before saving.');
  expect(writes).toHaveLength(1);
  expect(
    (writes[0]?.options.headers as Record<string, string>)['If-Match'],
  ).toBe('"2"');
  expect(screen.getByLabelText('Conversation name')).toHaveValue(
    'My edited title',
  );
  expect(screen.getByLabelText('Thinking')).toHaveAttribute(
    'data-value',
    'high',
  );
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Refresh latest values and models, keep my edits',
    }),
  );
  await screen.findByText(/Your edits are kept/);
  expect(writes).toHaveLength(1);
  expect(screen.getByLabelText('Conversation name')).toHaveValue(
    'My edited title',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(writes).toHaveLength(3));
  expect(
    (writes[1]?.options.headers as Record<string, string>)['If-Match'],
  ).toBe('"3"');
  expect(
    (writes[2]?.options.headers as Record<string, string>)['If-Match'],
  ).toBe('"4"');
});

it('does not treat an untouched initial name as rename intent after a later update or explicit refresh', async () => {
  const { writes, completeInitial, renameElsewhere } = fixture();
  await completeInitial('Current paired title');
  await chooseOption(screen.getByLabelText('Thinking'), 'high');
  renameElsewhere('A later title');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await screen.findByText('This resource changed. Reload before saving.');
  expect(writes.map((write) => write.url)).toEqual([
    '/api/chats/chat-a/settings',
  ]);
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Refresh latest values and models, keep my edits',
    }),
  );
  await screen.findByText(/Your edits are kept/);
  expect(screen.getByLabelText('Conversation name')).toHaveValue(
    'A later title',
  );
  expect(screen.getByLabelText('Thinking')).toHaveAttribute(
    'data-value',
    'high',
  );
  expect(writes).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes.map((write) => write.url)).toEqual([
    '/api/chats/chat-a/settings',
    '/api/chats/chat-a/settings',
  ]);
  expect(
    (writes[1]?.options.headers as Record<string, string>)['If-Match'],
  ).toBe('"3"');
});
