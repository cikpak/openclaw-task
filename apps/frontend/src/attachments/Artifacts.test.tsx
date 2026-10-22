import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ArtifactCatalog } from './Artifacts';
import { useChatProjection } from '../state/stores';
import { snapshot } from '../test/fixtures';

const file = {
  id: 'file-a',
  name: 'agent-notes.txt',
  mimeType: 'text/plain',
  sizeBytes: 1024,
};
const own = {
  uploadId: 'own-a',
  name: 'my-notes.txt',
  mimeType: 'text/plain',
  size: 2048,
};
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
function fixture() {
  const calls: {
    url: string;
    finish: (response: Response) => void;
  }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((finish) => {
          calls.push({ url, finish });
        }),
    ),
  );
  async function finish(index: number, data: unknown, status = 200) {
    const call = calls[index];
    if (!call) throw new Error(`Missing request ${index}`);
    await act(async () => {
      call.finish(reply(data, status));
      await Promise.resolve();
    });
  }
  return { calls, finish };
}
const toggle = () => screen.getByRole('button', { name: 'Conversation files' });
const shared = () => screen.getByRole('region', { name: 'Shared with agent' });
const agent = () => screen.getByRole('region', { name: 'From agent' });
beforeEach(() => useChatProjection.getState().clear());

it('loads both sources independently and lazily, keeps pending reads across close/reopen, and restores focus', async () => {
  const { calls, finish } = fixture();
  render(<ArtifactCatalog chatId="chat-a" />);
  expect(calls).toHaveLength(0);
  expect(
    screen.queryByRole('region', { name: 'Conversation files' }),
  ).not.toBeInTheDocument();
  await userEvent.click(toggle());
  expect(calls.map((call) => call.url)).toEqual([
    '/api/chats/chat-a/shared-files',
    '/api/chats/chat-a/artifacts',
  ]);
  const status = screen.getByRole('status', {
    name: 'Loading conversation files',
  });
  expect(status.querySelector('svg')).toHaveAttribute('width', '16');
  expect(status.querySelector('svg')).toHaveAttribute('height', '16');
  expect(status.querySelector('svg')).toHaveAttribute('viewBox', '0 0 24 24');
  expect(screen.getByRole('button', { name: 'Refresh files' })).toBeDisabled();
  await finish(0, { files: [own] });
  expect(within(shared()).getByText('my-notes.txt')).toBeVisible();
  expect(within(shared()).queryByRole('link')).not.toBeInTheDocument();
  expect(status).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole('button', { name: 'Close conversation files' }),
  );
  expect(toggle()).toHaveFocus();
  await userEvent.click(toggle());
  expect(calls).toHaveLength(2);
  await finish(1, { artifacts: [file] });
  expect(
    within(agent()).getByRole('button', { name: /agent-notes.txt/u }),
  ).toBeEnabled();
  expect(
    screen.queryByRole('status', { name: 'Loading conversation files' }),
  ).not.toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  expect(toggle()).toHaveFocus();
  await userEvent.click(toggle());
  expect(calls).toHaveLength(2);
});

it('keeps shared uploads visible when Gateway artifacts fail, with a section-only retry', async () => {
  const { calls, finish } = fixture();
  render(<ArtifactCatalog chatId="chat-a" />);
  await userEvent.click(toggle());
  await finish(1, { detail: 'Gateway unavailable.' }, 503);
  await finish(0, { files: [own] });
  expect(within(agent()).getByRole('alert')).toHaveTextContent(
    'Agent files: Gateway unavailable.',
  );
  expect(within(shared()).getByText('my-notes.txt')).toBeVisible();
  expect(within(shared()).getByText('2 KB')).toBeVisible();
  expect(
    within(agent()).queryByText('Files shared by this agent will appear here.'),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole('button', { name: 'Retry agent files' }),
  );
  expect(calls).toHaveLength(3);
  expect(calls[2]?.url).toBe('/api/chats/chat-a/artifacts');
  expect(
    screen.getByRole('button', { name: 'Retry agent files' }),
  ).toHaveAttribute('aria-busy', 'true');
  await finish(2, { artifacts: [] });
  expect(
    within(agent()).getByText('Files shared by this agent will appear here.'),
  ).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('does not hide successful agent files when the shared response is invalid', async () => {
  const { calls, finish } = fixture();
  render(<ArtifactCatalog chatId="chat-a" />);
  await userEvent.click(toggle());
  await finish(0, { files: [{ name: 'invalid' }] });
  await finish(1, { artifacts: [file] });
  expect(within(shared()).getByRole('alert')).toHaveTextContent(
    'Shared files could not be loaded.',
  );
  expect(
    within(agent()).getByRole('button', { name: /agent-notes.txt/u }),
  ).toBeVisible();
  await userEvent.click(
    screen.getByRole('button', { name: 'Retry shared files' }),
  );
  expect(calls[2]?.url).toBe('/api/chats/chat-a/shared-files');
  await finish(2, { files: [] });
  expect(
    within(shared()).getByText(
      'Files you send to this agent will appear here.',
    ),
  ).toBeVisible();
});
it('preserves both cached sections through a failed refresh while applying independent successes', async () => {
  const { calls, finish } = fixture();
  render(<ArtifactCatalog chatId="chat-a" />);
  await userEvent.click(toggle());
  await finish(0, { files: [own] });
  await finish(1, { artifacts: [file] });
  await userEvent.click(screen.getByRole('button', { name: 'Refresh files' }));
  expect(within(shared()).getByText('my-notes.txt')).toBeVisible();
  expect(
    within(agent()).getByRole('button', { name: /agent-notes.txt/u }),
  ).toBeVisible();
  await finish(2, {
    files: [own, { ...own, uploadId: 'new', name: 'new-notes.txt' }],
  });
  await finish(3, { detail: 'Agent is offline.' }, 503);
  expect(within(shared()).getByText('new-notes.txt')).toBeVisible();
  expect(
    within(agent()).getByRole('button', { name: /agent-notes.txt/u }),
  ).toBeEnabled();
  expect(within(agent()).getByRole('alert')).toHaveTextContent(
    'Agent is offline.',
  );
  expect(calls).toHaveLength(4);
});

it('keeps both cached sections while refreshing and ignores old reads on chat change', async () => {
  const { calls, finish } = fixture();
  const { rerender } = render(<ArtifactCatalog chatId="chat-a" />);
  await userEvent.click(toggle());
  await finish(0, { files: [own] });
  await finish(1, { artifacts: [file] });
  await userEvent.click(screen.getByRole('button', { name: 'Refresh files' }));
  expect(calls).toHaveLength(4);
  expect(within(shared()).getByText('my-notes.txt')).toBeVisible();
  expect(
    within(agent()).getByRole('button', { name: /agent-notes.txt/u }),
  ).toBeVisible();
  expect(
    screen.queryByRole('status', { name: 'Loading conversation files' }),
  ).not.toBeInTheDocument();
  rerender(<ArtifactCatalog chatId="chat-b" />);
  // In-flight manager reads may finish; their stale results stay scoped to the previous chat.
  expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  await finish(2, { files: [own] });
  await finish(3, { artifacts: [file] });
  expect(screen.queryByText('my-notes.txt')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /agent-notes.txt/u }),
  ).not.toBeInTheDocument();
  await userEvent.click(toggle());
  expect(calls.slice(4).map((call) => call.url)).toEqual([
    '/api/chats/chat-b/shared-files',
    '/api/chats/chat-b/artifacts',
  ]);
  await finish(4, { files: [] });
  await finish(5, { artifacts: [] });
});

it('refreshes accepted sends and completion while open, ignores streaming text and never displays local unknown files', async () => {
  const { calls, finish } = fixture();
  useChatProjection.setState({ snapshots: { 'chat-a': snapshot } });
  render(<ArtifactCatalog chatId="chat-a" />);
  await userEvent.click(toggle());
  await finish(0, { files: [] });
  await finish(1, { artifacts: [] });
  const queued = {
    id: 'pending',
    chatId: 'chat-a',
    text: 'Own upload',
    attachments: [own],
    state: 'unknown' as const,
    position: 1,
    revision: 1,
    submissionId: 'submission',
    createdAt: 1,
  };
  act(() =>
    useChatProjection.setState({
      snapshots: { 'chat-a': { ...snapshot, pending: [queued] } },
    }),
  );
  expect(calls).toHaveLength(4);
  await finish(2, { files: [] });
  await finish(3, { artifacts: [] });
  expect(screen.queryByText('my-notes.txt')).not.toBeInTheDocument();
  const running = {
    ...snapshot,
    pending: [{ ...queued, state: 'submitted' as const }],
    activeRun: { id: 'run', text: '', sequence: 1 },
  };
  act(() => useChatProjection.setState({ snapshots: { 'chat-a': running } }));
  await finish(4, { files: [own] });
  await finish(5, { artifacts: [] });
  expect(within(shared()).getByText('my-notes.txt')).toBeVisible();
  act(() =>
    useChatProjection.setState({
      snapshots: {
        'chat-a': {
          ...running,
          activeRun: { id: 'run', text: 'Token delta', sequence: 2 },
        },
      },
    }),
  );
  expect(calls).toHaveLength(6);
  act(() =>
    useChatProjection.setState({
      snapshots: { 'chat-a': { ...running, activeRun: null } },
    }),
  );
  expect(calls).toHaveLength(8);
  await finish(6, { files: [own] });
  await finish(7, { artifacts: [file] });
  expect(
    within(agent()).getByRole('button', { name: /agent-notes.txt/u }),
  ).toBeVisible();
});

it('defers dirty pending reads until reopening and makes no closed-panel background requests', async () => {
  const { calls, finish } = fixture();
  render(<ArtifactCatalog chatId="chat-a" />);
  await userEvent.click(toggle());
  act(() =>
    useChatProjection.setState({
      snapshots: {
        'chat-a': { ...snapshot, chat: { ...snapshot.chat, updatedAt: 2 } },
      },
    }),
  );
  expect(calls).toHaveLength(2);
  await userEvent.click(
    screen.getByRole('button', { name: 'Close conversation files' }),
  );
  await finish(0, { files: [] });
  await finish(1, { artifacts: [] });
  expect(calls).toHaveLength(2);
  await userEvent.click(toggle());
  expect(calls).toHaveLength(4);
  await finish(2, { files: [own] });
  await finish(3, { artifacts: [] });
  expect(within(shared()).getByText('my-notes.txt')).toBeVisible();
  await userEvent.click(
    screen.getByRole('button', { name: 'Close conversation files' }),
  );
  act(() =>
    useChatProjection.setState({
      snapshots: {
        'chat-a': { ...snapshot, chat: { ...snapshot.chat, updatedAt: 3 } },
      },
    }),
  );
  expect(calls).toHaveLength(4);
});
