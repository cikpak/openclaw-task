import { testConnectionTicket } from '../test/socket';

import { act, render, screen, waitFor } from '@testing-library/react';
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
  expect(
    fetch.mock.calls.some(
      ([url, options]) =>
        url !== '/api/connection-tickets' && !!options?.method,
    ),
  ).toBe(false);
});
