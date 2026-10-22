import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { useChatProjection, useDrafts, useModelCatalog } from '../state/stores';
import { snapshot } from '../test/fixtures';
import {
  currentSocket,
  installTestSocket,
  TestSocket,
  testConnectionTicket,
} from '../test/socket';
import { ConnectionProvider } from './ConnectionProvider';
import { ConversationPage } from './ConversationPage';

it('opens cached unread history and marks it read through manager commands without requesting native older history', async () => {
  useChatProjection.getState().clear();
  useDrafts.getState().clear();
  useModelCatalog.getState().clear();
  installTestSocket();
  const unread = {
    ...snapshot,
    chat: { ...snapshot.chat, unread: true },
    messages: [
      {
        id: 'cached-answer',
        role: 'assistant' as const,
        text: 'Saved while you were away',
        createdAt: 1,
      },
    ],
  };
  TestSocket.snapshots = [unread];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        Response.json(
          url === '/api/session'
            ? { authenticated: true, username: 'owner' }
            : url === '/api/connection-tickets'
              ? testConnectionTicket()
              : url === '/api/chats'
                ? { chats: [unread.chat] }
                : { models: [] },
        ),
      ),
    ),
  );
  render(
    <MemoryRouter initialEntries={['/chat/chat-a']}>
      <AuthProvider>
        <ConnectionProvider>
          <Routes>
            <Route path="/chat/:chatId" element={<ConversationPage />} />
          </Routes>
        </ConnectionProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(
      currentSocket().commands.some(
        (command) =>
          command.type === 'conversation.message.read' &&
          command.chatId === 'chat-a',
      ),
    ).toBe(true),
  );
  expect(currentSocket().commands).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'conversation.recent.request',
        chatId: 'chat-a',
      }),
      expect.objectContaining({
        type: 'conversation.message.read',
        chatId: 'chat-a',
      }),
    ]),
  );
  expect(
    currentSocket().commands.some(
      (command) => command.type === 'conversation.history.request',
    ),
  ).toBe(false);
  expect(
    currentSocket()
      .commands.filter((command) => command.type === 'models.list')
      .every((command) => command.cachedOnly),
  ).toBe(true);
});
