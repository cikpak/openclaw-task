import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AttachmentPicker } from '../attachments/AttachmentPicker';
import {
  useChatProjection,
  useModelCatalog,
  useNotices,
  usePreferences,
} from '../state/stores';
import { models, snapshot } from '../test/fixtures';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

const auth = vi.hoisted(() => ({
  authenticated: false,
  login: vi.fn<(username: string, password: string) => Promise<void>>(),
  logout: vi.fn<() => Promise<void>>(),
}));
vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    session: { authenticated: auth.authenticated, username: 'admin' },
    loading: false,
    error: '',
    login: auth.login,
    logout: auth.logout,
    refresh: vi.fn(),
  }),
}));
vi.mock('../conversation/ConnectionProvider', () => ({
  ConnectionProvider: ({ children }: { children: ReactNode }) => children,
}));
beforeEach(() => {
  auth.authenticated = false;
  auth.login.mockReset().mockResolvedValue(undefined);
  auth.logout.mockReset().mockResolvedValue(undefined);
  useChatProjection.getState().clear();
  useChatProjection.setState({ transport: 'open', connection: 'ready' });
  usePreferences.getState().clear();
  useModelCatalog.getState().clear();
  useNotices.setState({ notices: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url === '/api/chats'
              ? { chats: [] }
              : url === '/api/models'
                ? { models }
                : {
                    defaults: snapshot.chat.settings,
                    busySendBehavior: 'queue',
                    version: 1,
                  },
          ),
          { headers: { 'Content-Type': 'application/json', ETag: '"1"' } },
        ),
      ),
    ),
  );
});
function app(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

it('keeps the login form first in DOM order and the supplied black hero content second', () => {
  const { container } = app('/login');
  const main = screen.getByRole('main');
  expect(main.children[0]?.querySelector('form')).not.toBeNull();
  expect(main.children[1]?.querySelector('h1')).toHaveTextContent(
    'A place foryour next idea.',
  );
  expect(screen.getByText(/Independent agents/)).toHaveTextContent(
    'Conversations that keep moving.',
  );
  expect(container.textContent).not.toContain('YOUR PRIVATE WORKSPACE');
});

it('centers the home placeholder within available content and removes the old slogan', async () => {
  auth.authenticated = true;
  const { container } = app();
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(container.textContent).not.toContain('SPACE TO DO GOOD WORK');
  expect(
    screen.getByRole('heading', { name: /Your agents/ }),
  ).toBeInTheDocument();
});

it('adds sidebar Settings hover/focus treatment and a larger admin label', async () => {
  auth.authenticated = true;
  app();
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(
    screen.getByRole('link', { name: 'Settings admin' }),
  ).toBeInTheDocument();
});

it('uses 16px official outline glyphs for every functional icon without changing source viewboxes', () => {
  const names: IconName[] = [
    'arrowRight',
    'arrowUp',
    'arrowLeft',
    'arrowUpRight',
    'plus',
    'close',
    'chevronDown',
    'check',
    'refresh',
    'stop',
    'file',
    'download',
    'paperclip',
    'tool',
    'settings',
    'logout',
    'spinner',
  ];
  const { container } = render(
    <>
      {names.map((name) => (
        <Icon key={name} name={name} />
      ))}
    </>,
  );
  const glyphs = container.querySelectorAll('svg');
  expect(glyphs).toHaveLength(names.length);
  for (const glyph of glyphs) {
    expect(glyph).toHaveAttribute('width', '16');
    expect(glyph).toHaveAttribute('height', '16');
    expect(glyph).toHaveStyle({
      width: '16px',
      height: '16px',
      flexShrink: '0',
    });
    expect(glyph).toHaveAttribute('viewBox', '0 0 24 24');
    expect(glyph).toHaveAttribute('fill', 'none');
    expect(glyph).toHaveAttribute('stroke-width', '1.5');
    expect(glyph).toHaveAttribute('focusable', 'false');
    expect(glyph).toHaveAttribute('data-slot', 'icon');
  }
});

it('reserves the same 16px slot during button loading and does not shrink mobile targets', () => {
  const { rerender } = render(<Button icon="logout">Sign out</Button>);
  const slot = screen.getByRole('button').firstElementChild;
  const outline = screen.getByRole('button').querySelector('svg')?.innerHTML;
  rerender(
    <Button icon="logout" busy>
      Sign out
    </Button>,
  );
  expect(screen.getByRole('button').firstElementChild).toBe(slot);
  expect(screen.getByRole('button')).toBeDisabled();
  expect(screen.getByRole('button').querySelector('svg')).toHaveAttribute(
    'width',
    '16',
  );
  expect(screen.getByRole('button').querySelector('svg')?.innerHTML).not.toBe(
    outline,
  );
});

it('shows the actual Settings Sign out icon and keeps its slot stable while logging out', async () => {
  auth.authenticated = true;
  let complete!: () => void;
  auth.logout.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  app('/settings');
  await waitFor(() =>
    expect(screen.getByLabelText('Custom instructions')).toBeEnabled(),
  );
  const signout = screen.getByRole('button', { name: 'Sign out' });
  const slot = signout.firstElementChild;
  expect(signout.querySelector('svg')).toHaveAttribute('width', '16');
  const initialIcon = signout.querySelector('svg')?.innerHTML;
  fireEvent.click(signout);
  expect(auth.logout).toHaveBeenCalledOnce();
  expect(signout).toHaveAttribute('aria-busy', 'true');
  expect(signout.firstElementChild).toBe(slot);
  expect(signout.querySelector('svg')?.innerHTML).not.toBe(initialIcon);
  await act(async () => {
    complete();
    await Promise.resolve();
  });
});

it('removes upload focus outlines but keeps pointer access and a background focus cue', () => {
  render(<AttachmentPicker attachments={[]} onChange={vi.fn()} />);
  const upload = screen.getByLabelText('Attach files');
  expect(upload).toHaveAttribute('type', 'file');
  act(() => upload.focus());
  expect(upload).toHaveFocus();
});

it('renders shared focusable notifications inline, outside modal ownership, with reduced-motion tokens', async () => {
  auth.authenticated = true;
  app();
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  act(() => useNotices.getState().add('Preferences saved.'));
  const toast = screen.getByRole('group', { name: 'Notification' });
  expect(toast).toHaveAttribute('tabindex', '0');
  expect(toast.closest('dialog')).toBeNull();
  expect(toast.parentElement).toHaveAttribute('aria-live', 'polite');
});
