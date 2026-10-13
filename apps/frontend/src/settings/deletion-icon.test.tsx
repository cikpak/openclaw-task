import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { useChatProjection, useModelCatalog } from '../state/stores';
import { models, snapshot } from '../test/fixtures';
import { ChatSettingsPanel } from './ChatSettingsPanel';

vi.mock('../conversation/ConnectionProvider', () => ({
  useConversation: () => vi.fn(),
}));

beforeEach(() => {
  useChatProjection.getState().clear();
  useModelCatalog.getState().clear();
});

async function confirmation() {
  let finish!: (response: Response) => void;
  const deletion = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetch = vi.fn((url: string, options: RequestInit = {}) => {
    if (options.method === 'DELETE') return deletion;
    return Promise.resolve(
      new Response(
        JSON.stringify(
          url.startsWith('/api/models') ? { models } : snapshot.chat,
        ),
        { headers: { 'Content-Type': 'application/json', ETag: '"1"' } },
      ),
    );
  });
  vi.stubGlobal('fetch', fetch);
  render(<ChatSettingsPanel snapshot={snapshot} onClose={vi.fn()} />);
  const start = screen.getByRole('button', { name: 'Delete conversation…' });
  await waitFor(() => expect(start).toBeEnabled());
  await userEvent.click(start);
  return {
    button: screen.getByRole('button', { name: 'Confirm deletion' }),
    fetch,
    finish,
    deletion,
  };
}

it('renders a visible 16px outline icon in the confirmation action without deleting on open', async () => {
  const { button, fetch } = await confirmation();
  const icon = button.querySelector('svg');
  expect(icon).toBeVisible();
  expect(icon).toHaveAttribute('width', '16');
  expect(icon).toHaveAttribute('height', '16');
  expect(icon).toHaveAttribute('fill', 'none');
  expect(icon).toHaveAttribute('stroke', 'currentColor');
  expect(icon).toHaveAttribute('aria-hidden', 'true');
  expect(icon?.querySelector('path')).not.toBeNull();
  expect(
    fetch.mock.calls.some(([, options]) => options?.method === 'DELETE'),
  ).toBe(false);
});

it('retains the same icon slot when the confirmation changes to a loading spinner', async () => {
  const { button, fetch, finish, deletion } = await confirmation();
  const slot = button.firstElementChild;
  const trash = button.querySelector('svg')?.innerHTML;
  await userEvent.click(button);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
  expect(button.firstElementChild).toBe(slot);
  expect(button.querySelector('svg')).toHaveAttribute('width', '16');
  expect(button.querySelector('svg')?.innerHTML).not.toBe(trash);
  expect(
    fetch.mock.calls.filter(([, options]) => options?.method === 'DELETE'),
  ).toHaveLength(1);
  await act(async () => {
    finish(
      new Response(JSON.stringify({ detail: 'Fixture retry' }), {
        status: 409,
      }),
    );
    await deletion;
  });
  await waitFor(() => expect(button).toBeEnabled());
  expect(button.querySelector('svg')?.innerHTML).toBe(trash);
});
