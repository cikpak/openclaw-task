import { testConnectionTicket } from '../test/socket';
import { chooseOption } from '../test/select';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { AuthProvider } from '../auth/AuthProvider';

import { ChatSettingsPanel } from '../settings/ChatSettingsPanel';
import {
  useChatProjection,
  useDrafts,
  useModelCatalog,
  usePreferences,
} from '../state/stores';
import { models, snapshot } from '../test/fixtures';
import { installTestSocket } from '../test/socket';

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
