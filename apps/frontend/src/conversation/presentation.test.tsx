import { testConnectionTicket } from '../test/socket';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { useChatProjection, useDrafts, usePreferences } from '../state/stores';
import { snapshot } from '../test/fixtures';
import { currentSocket, installTestSocket, TestSocket } from '../test/socket';
import { Composer } from './Composer';
import { ConnectionProvider } from './ConnectionProvider';
import { ConversationMessages } from './MessageBubble';
import { ConversationPage } from './ConversationPage';

beforeEach(() => {
  useChatProjection.getState().clear();
  useDrafts.getState().clear();
  usePreferences.getState().clear();
  installTestSocket();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url === '/api/connection-tickets'
              ? testConnectionTicket()
              : { authenticated: true },
          ),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      ),
    ),
  );
});
const common = { tools: [], aborting: false, onAbort: vi.fn() };

it('renders submitted messages and tool activity before the final thinking bubble', async () => {
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
    expect(useChatProjection.getState().connection).toBe('ready'),
  );
  act(() =>
    useChatProjection.getState().applySnapshot({
      ...snapshot,
      messages: [
        {
          id: 'previous',
          role: 'assistant',
          text: 'Previous response',
          createdAt: 1,
        },
      ],
      activeRun: { id: 'run', text: '', sequence: 0 },
      pending: [
        {
          id: 'submitted',
          chatId: 'chat-a',
          position: 1,
          revision: 1,
          text: 'Tell me about yourself Jonathan',
          attachments: [],
          state: 'submitted',
          createdAt: 2,
          submissionId: 'submission',
        },
      ],
      tools: [
        {
          id: 'read',
          name: 'read',
          status: 'completed',
          parameters: '{}',
          output: 'Result',
        },
      ],
    }),
  );
  const thinking = screen
    .getByRole('status', { name: 'Agent is thinking' })
    .closest('article')!;
  const submitted = screen
    .getByText('Tell me about yourself Jonathan')
    .closest('article')!;
  const tool = screen.getByRole('button', {
    name: 'read · completed · Tool details',
  });
  expect(tool).toHaveTextContent('Read');
  expect(tool).toHaveAttribute('aria-expanded', 'false');
  expect(
    submitted.compareDocumentPosition(thinking) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    tool.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(thinking.parentElement?.lastElementChild).toBe(thinking);
});

it('distinguishes a tool-only interval from waiting for response text', () => {
  render(
    <ConversationMessages
      {...common}
      tools={[
        {
          id: 'tool',
          name: 'Search',
          status: 'running',
          parameters: '{}',
          output: '',
        },
      ]}
      snapshot={{
        ...snapshot,
        activeRun: { id: 'run', text: '', sequence: 0 },
      }}
    />,
  );
  expect(
    screen.getByRole('status', { name: 'Agent is using tools' }),
  ).toHaveTextContent('Using tools…');
  expect(
    screen.queryByRole('status', { name: 'Agent is thinking' }),
  ).not.toBeInTheDocument();
});

it('shows a thinking shimmer only before the first real active response text', () => {
  const { rerender } = render(
    <ConversationMessages
      {...common}
      snapshot={{
        ...snapshot,
        activeRun: { id: 'run', text: '', sequence: 0 },
      }}
    />,
  );
  expect(
    screen.getByRole('status', { name: 'Agent is thinking' }),
  ).toHaveTextContent('Thinking…');
  const bubble = document.querySelector('[data-message-state="active"]');
  rerender(
    <ConversationMessages
      {...common}
      snapshot={{
        ...snapshot,
        activeRun: { id: 'run', text: ' \n', sequence: 1 },
      }}
    />,
  );
  expect(
    screen.getByRole('status', { name: 'Agent is thinking' }),
  ).toHaveTextContent('Thinking…');
  rerender(
    <ConversationMessages
      {...common}
      snapshot={{
        ...snapshot,
        activeRun: { id: 'run', text: 'Actual partial output', sequence: 2 },
      }}
    />,
  );
  expect(
    screen.queryByRole('status', { name: 'Agent is thinking' }),
  ).not.toBeInTheDocument();
  expect(screen.getByText('Actual partial output').closest('article')).toBe(
    bubble,
  );
  rerender(<ConversationMessages {...common} snapshot={snapshot} />);
  expect(
    screen.queryByRole('status', { name: 'Agent is thinking' }),
  ).not.toBeInTheDocument();
});

it('keeps a confirmed run bubble mounted when its canonical message arrives', () => {
  const { rerender } = render(
    <ConversationMessages
      {...common}
      snapshot={{
        ...snapshot,
        activeRun: { id: 'run', text: 'Response', sequence: 1 },
      }}
    />,
  );
  const bubble = screen.getByText('Response').closest('article');
  rerender(
    <ConversationMessages
      {...common}
      snapshot={{
        ...snapshot,
        messages: [
          {
            id: 'canonical',
            role: 'assistant',
            text: 'Response',
            createdAt: 1,
            runId: 'run',
          },
        ],
      }}
    />,
  );
  expect(screen.getByText('Response').closest('article')).toBe(bubble);
  expect(bubble).toHaveAttribute('data-message-state', 'canonical');
  expect(
    screen.queryByRole('button', { name: 'Stop this run' }),
  ).not.toBeInTheDocument();
});

it('does not hide live content when earlier canonical commentary shares the same runId', () => {
  render(
    <ConversationMessages
      {...common}
      snapshot={{
        ...snapshot,
        messages: [
          {
            id: 'commentary',
            role: 'assistant',
            text: 'Looking this up',
            createdAt: 1,
            runId: 'run',
          },
        ],
        activeRun: { id: 'run', text: 'New response tokens', sequence: 2 },
      }}
    />,
  );
  expect(screen.getByText('Looking this up')).toBeVisible();
  expect(screen.getByText('New response tokens')).toBeVisible();
  expect(document.querySelectorAll('[data-message-id]')).toHaveLength(2);
});

it('hands a multi-message run preview to its latest confirmed canonical row without remounting', () => {
  const commentary = {
    id: 'commentary',
    role: 'assistant' as const,
    text: 'Looking this up',
    createdAt: 1,
    runId: 'run',
  };
  const { rerender } = render(
    <ConversationMessages
      {...common}
      snapshot={{
        ...snapshot,
        messages: [commentary],
        activeRun: { id: 'run', text: 'Final response', sequence: 2 },
      }}
    />,
  );
  const preview = screen.getByText('Final response').closest('article');
  rerender(
    <ConversationMessages
      {...common}
      snapshot={{
        ...snapshot,
        messages: [
          commentary,
          {
            id: 'final',
            role: 'assistant',
            text: 'Final response',
            createdAt: 2,
            runId: 'run',
          },
        ],
      }}
    />,
  );
  expect(screen.getByText('Final response').closest('article')).toBe(preview);
  expect(screen.getAllByText('Looking this up')).toHaveLength(1);
});

it.each([
  ['final', 'Response complete · syncing transcript'],
  ['aborted', 'Stopped · partial response'],
  ['error', 'Interrupted · partial response'],
] as const)(
  'retains %s preview without pretending it is an active or canonical response',
  (state, label) => {
    render(
      <ConversationMessages
        {...common}
        snapshot={{
          ...snapshot,
          settledRun: {
            id: 'run',
            text: 'Retained partial response',
            sequence: 1,
            state,
          },
        }}
      />,
    );
    expect(screen.getByText(label)).toBeVisible();
    expect(
      screen.getByText('Retained partial response').closest('article'),
    ).toHaveAttribute('data-message-state', 'settled');
    expect(
      screen.queryByRole('status', { name: 'Agent is thinking' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Stop this run' }),
    ).not.toBeInTheDocument();
  },
);

it('does not duplicate a settled preview when the matching canonical response arrives', () => {
  render(
    <ConversationMessages
      {...common}
      snapshot={{
        ...snapshot,
        settledRun: {
          id: 'run',
          text: 'Response',
          sequence: 1,
          state: 'final',
        },
        messages: [
          {
            id: 'canonical',
            role: 'assistant',
            text: 'Response',
            createdAt: 1,
            runId: 'run',
          },
        ],
      }}
    />,
  );
  expect(screen.getAllByText('Response')).toHaveLength(1);
  expect(document.querySelector('[data-message-id]')).toHaveAttribute(
    'data-message-state',
    'canonical',
  );
});

it('keeps the initiating send label while an active run arrives before its receipt', async () => {
  function LiveComposer() {
    const value =
      useChatProjection((state) => state.snapshots['chat-a']) ?? snapshot;
    return <Composer snapshot={value} />;
  }
  render(
    <AuthProvider>
      <ConnectionProvider>
        <LiveComposer />
      </ConnectionProvider>
    </AuthProvider>,
  );
  await waitFor(() =>
    expect(useChatProjection.getState().connection).toBe('ready'),
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Message Research' }),
    'A request',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
  const command = currentSocket().commands.find(
    (item) => item.type === 'conversation.message.send',
  );
  if (!command) throw new Error('Missing send command');
  act(() =>
    useChatProjection.getState().applySnapshot({
      ...snapshot,
      activeRun: { id: 'run', text: '', sequence: 0 },
    }),
  );
  expect(screen.getByRole('button', { name: 'Send message' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  expect(
    screen.getByRole('combobox', { name: 'Send behavior' }),
  ).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: 'Queue message' }),
  ).not.toBeInTheDocument();
  act(() =>
    currentSocket().receive({
      type: 'command.result',
      commandId: command.commandId,
      ok: true,
      data: { messageId: 'accepted' },
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Queue message' }),
    ).not.toHaveAttribute('aria-busy'),
  );
});

it('keeps the same header and draft composer mounted through the initial snapshot read', async () => {
  class DelayedSocket extends TestSocket {
    constructor() {
      super();
      this.autoSnapshots = false;
    }
  }
  vi.stubGlobal('WebSocket', DelayedSocket);
  useChatProjection.setState({ chats: { 'chat-a': snapshot.chat } });
  useDrafts.getState().setText('chat-a', 'Previously saved draft');
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
  const input = await screen.findByRole('textbox', {
    name: 'Message Research',
  });
  const header = screen
    .getByRole('heading', { name: 'Research' })
    .closest('header');
  expect(input).toBeDisabled();
  expect(input).toHaveValue('Previously saved draft');
  await waitFor(() =>
    expect(
      currentSocket().commands.some(
        (command) => command.type === 'conversation.snapshot.request',
      ),
    ).toBe(true),
  );
  act(() => useChatProjection.getState().applySnapshot(snapshot));
  expect(screen.getByRole('textbox', { name: 'Message Research' })).toBe(input);
  expect(
    screen.getByRole('heading', { name: 'Research' }).closest('header'),
  ).toBe(header);
  expect(input).toBeEnabled();
  expect(input).toHaveValue('Previously saved draft');
});
