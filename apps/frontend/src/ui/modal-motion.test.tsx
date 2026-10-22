import { testConnectionTicket } from '../test/socket';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Modal } from './Modal';
import { Select } from './Select';
import { ChatSettingsPanel } from '../settings/ChatSettingsPanel';
import { snapshot, models } from '../test/fixtures';
import { installTestSocket } from '../test/socket';
import { AuthProvider } from '../auth/AuthProvider';
import { ConnectionProvider } from '../conversation/ConnectionProvider';
import { useModelCatalog } from '../state/stores';

function DialogForm() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open ? (
        <Modal title="Example" onClose={() => setOpen(false)}>
          {(close) => (
            <>
              <Select
                label="Choice"
                value="a"
                options={[{ value: 'a', label: 'Alpha' }]}
                onChange={() => undefined}
              />
              <button onClick={close}>Cancel</button>
            </>
          )}
        </Modal>
      ) : null}
    </>
  );
}
it('retains native dialog and disables actions for exit, then restores focus and can reopen', async () => {
  render(<DialogForm />);
  const trigger = screen.getByRole('button', { name: 'Open' });
  await userEvent.click(trigger);
  const dialog = screen.getByRole('dialog');
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(dialog).toHaveAttribute('open');
  expect(dialog).toHaveAttribute('data-closing', 'true');
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
  await userEvent.click(trigger);
  expect(screen.getByRole('dialog')).not.toHaveAttribute('data-closing');
});
it('portals options into the native dialog and dismisses the select before the dialog', async () => {
  render(<DialogForm />);
  await userEvent.click(screen.getByRole('button', { name: 'Open' }));
  const dialog = screen.getByRole('dialog');
  await userEvent.click(screen.getByRole('combobox'));
  await act(async () => {});
  expect(dialog).toContainElement(screen.getByRole('listbox'));
  const escape = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  document.activeElement?.dispatchEvent(escape);
  await act(async () => {});
  expect(escape.defaultPrevented).toBe(true);
  expect(screen.getByRole('combobox')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  expect(dialog).not.toHaveAttribute('data-closing');
  fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }));
  expect(dialog).toHaveAttribute('data-closing', 'true');
});
it('closes immediately for reduced motion and cleans timers on route-like unmount', async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true })),
  );
  render(<DialogForm />);
  await userEvent.click(screen.getByRole('button', { name: 'Open' }));
  await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  );
  const onClose = vi.fn();
  const { unmount } = render(
    <Modal title="Leaving" onClose={onClose}>
      Content
    </Modal>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  unmount();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(onClose).not.toHaveBeenCalled();
});
it('applies the same retained exit to the independent Agent Settings dialog', async () => {
  installTestSocket();
  useModelCatalog.getState().clear();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url === '/api/connection-tickets'
              ? testConnectionTicket()
              : url.includes('/models')
                ? { models }
                : url === '/api/auth/session'
                  ? {
                      authenticated: true,
                      username: 'owner',
                      csrfToken: 'csrf',
                    }
                  : snapshot.chat,
          ),
          { headers: { 'Content-Type': 'application/json', ETag: '"1"' } },
        ),
      ),
    ),
  );
  const onClose = vi.fn();
  render(
    <AuthProvider>
      <ConnectionProvider>
        <ChatSettingsPanel snapshot={snapshot} onClose={onClose} />
      </ConnectionProvider>
    </AuthProvider>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Agent settings' });
  await userEvent.click(screen.getByRole('button', { name: /^Close$/ }));
  expect(dialog).toHaveAttribute('data-closing', 'true');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  expect(onClose).not.toHaveBeenCalled();
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});
