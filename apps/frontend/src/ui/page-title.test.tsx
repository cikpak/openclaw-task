import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { useChatProjection } from '../state/stores';
import { snapshot } from '../test/fixtures';
import { PageTitle } from './PageTitle';

const auth = vi.hoisted(() => ({
  session: { authenticated: true, username: 'owner' },
  loading: false,
  error: '',
  refresh: vi.fn(),
}));
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('../conversation/ConnectionProvider', () => ({
  ConnectionProvider: ({ children }: { children: React.ReactNode }) => children,
}));
beforeEach(() => {
  auth.session.authenticated = true;
  auth.loading = false;
  auth.error = '';
  useChatProjection.getState().clear();
  // Footer tests must not overwrite the controlled projection with API reads.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
});

it.each([
  ['/', 'Conversations'],
  ['/settings', 'Settings'],
  ['/chat/unknown', 'Conversation'],
  ['/unknown', 'Conversations'],
])('uses a safe route title for %s', (path, title) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <PageTitle />
    </MemoryRouter>,
  );
  expect(document.title).toBe(`${title} — OpenClaw`);
});
it('updates chat identity on rename, but never includes message text or deleted names', () => {
  useChatProjection.setState({
    chats: { 'chat-a': snapshot.chat },
    snapshots: {
      'chat-a': {
        ...snapshot,
        messages: [
          {
            id: 'message-private',
            role: 'user',
            text: 'Private prompt',
            createdAt: 1,
            attachments: [],
            artifacts: [],
          },
        ],
      },
    },
  });
  render(
    <MemoryRouter initialEntries={['/chat/chat-a']}>
      <PageTitle />
    </MemoryRouter>,
  );
  expect(document.title).toBe('Research — OpenClaw');
  act(() =>
    useChatProjection
      .getState()
      .mergeChat({ ...snapshot.chat, name: 'Renamed', version: 2 }),
  );
  expect(document.title).toBe('Renamed — OpenClaw');
  act(() =>
    useChatProjection.setState({ chats: {}, deletedChats: { 'chat-a': 3 } }),
  );
  expect(document.title).toBe('Conversation — OpenClaw');
  expect(document.title).not.toContain('Private prompt');
});
it('keeps startup, unavailable and signed-out titles accurate', () => {
  auth.loading = true;
  const { rerender } = render(
    <MemoryRouter>
      <PageTitle />
    </MemoryRouter>,
  );
  expect(document.title).toBe('Opening workspace — OpenClaw');
  auth.loading = false;
  auth.error = 'Cannot connect';
  rerender(
    <MemoryRouter>
      <PageTitle />
    </MemoryRouter>,
  );
  expect(document.title).toBe('Workspace unavailable — OpenClaw');
  auth.error = '';
  auth.session.authenticated = false;
  rerender(
    <MemoryRouter>
      <PageTitle />
    </MemoryRouter>,
  );
  expect(document.title).toBe('Sign in — OpenClaw');
});
it.each([
  ['open', 'ready', 'ready', 'Gateway connected'],
  ['open', 'connecting', 'connecting', 'Connecting…'],
  ['open', 'unavailable', 'unavailable', 'Gateway unavailable'],
  ['connecting', 'ready', 'connecting', 'Connecting…'],
  ['closed', 'ready', 'unavailable', 'Gateway unavailable'],
] as const)(
  'derives %s transport / %s Gateway status without stale green',
  (transport, connection, effective, label) => {
    useChatProjection.setState({ transport, connection });
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    const status = screen.getByText(label, { exact: true });
    expect(status).toHaveAttribute('role', 'status');
    expect(status.querySelector('i')).toHaveAttribute(
      'data-connection-state',
      effective,
    );
    expect(status.querySelector('i')).toHaveAttribute('aria-hidden', 'true');
  },
);
it('changes from connected to unavailable immediately when transport closes', () => {
  useChatProjection.setState({ transport: 'open', connection: 'ready' });
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  expect(
    screen.getByText('Gateway connected', { exact: true }),
  ).toBeInTheDocument();
  act(() => useChatProjection.getState().markTransportClosed());
  expect(
    screen.queryByText('Gateway connected', { exact: true }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText('Gateway unavailable', { exact: true }),
  ).toBeInTheDocument();
  act(() => useChatProjection.getState().beginConnection());
  expect(screen.getByText('Connecting…', { exact: true })).toBeInTheDocument();
});
