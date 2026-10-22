import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { useChatProjection, useDrafts, useNotices } from '../state/stores';
import { snapshot } from '../test/fixtures';
import {
  currentSocket,
  installTestSocket,
  testConnectionTicket,
} from '../test/socket';
import { Composer } from './Composer';
import { ConnectionProvider } from './ConnectionProvider';

afterEach(() => vi.useRealTimers());
it('durable acknowledgement prevents false delivery failure or replay during a wake longer than 15 seconds', async () => {
  useChatProjection.getState().clear();
  useDrafts.getState().clear();
  useNotices.setState({ notices: [] });
  installTestSocket();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        Response.json(
          url === '/api/connection-tickets'
            ? testConnectionTicket()
            : url === '/api/session'
              ? { authenticated: true, username: 'owner' }
              : { chats: [snapshot.chat] },
        ),
      ),
    ),
  );
  render(
    <AuthProvider>
      <ConnectionProvider>
        <Composer snapshot={snapshot} />
      </ConnectionProvider>
    </AuthProvider>,
  );
  await waitFor(() =>
    expect(useChatProjection.getState().connection).toBe('ready'),
  );
  vi.useFakeTimers();
  const input = screen.getByRole('textbox', { name: 'Message Research' });
  fireEvent.change(input, {
    target: { value: 'Persist this while the engine wakes' },
  });
  fireEvent.submit(input.closest('form')!);
  const socket = currentSocket();
  const sent = socket.commands.find(
    (command) => command.type === 'conversation.message.send',
  );
  if (!sent) throw Error('Send was not issued');
  act(() =>
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'command.result',
        commandId: sent.commandId,
        ok: true,
        data: {
          messageId: 'accepted-message',
          receipt: {
            commandId: sent.commandId,
            acceptedAt: Date.now(),
            state: 'accepted',
          },
        },
      }),
    }),
  );
  await act(async () => Promise.resolve());
  expect(input).toHaveValue('');
  act(() => {
    vi.advanceTimersByTime(20_000);
  });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(useNotices.getState().notices).toEqual([]);
  expect(
    socket.commands.filter(
      (command) => command.type === 'conversation.message.send',
    ),
  ).toHaveLength(1);
  fireEvent.change(input, {
    target: { value: 'Next message remains available' },
  });
  expect(
    screen.getByRole('button', { name: /Send message/ }),
  ).not.toHaveAttribute('disabled');
});
