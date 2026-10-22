import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AgentMessageContent } from '../conversation/AgentMessageContent';
import { registerApplicationDispatcher } from '../lib/manager';
import { artifactValid } from '../lib/validation';

const file = {
  id: 'opaque-document',
  name: 'review.txt',
  mimeType: 'text/plain',
  sizeBytes: 4,
  category: 'deliverable' as const,
  updatedAt: 1,
};
it('downloads an exact inline-code publication reference and leaves fenced code and other literals inert', async () => {
  const dispatch = vi.fn().mockResolvedValue({
    file,
    download: {
      url: `/downloads/${'c'.repeat(64)}`,
      expiresAt: Date.now() + 60000,
    },
  });
  registerApplicationDispatcher(dispatch);
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('review.txt');
      expect(this.getAttribute('href')).toBe(`/downloads/${'c'.repeat(64)}`);
    });
  const { container } = render(
    <AgentMessageContent
      chatId="chat-a"
      text={
        'Saved `file:opaque-document`.\n\n```\nfile:opaque-document\n```\n\n`documents/private.txt:1` and `example file:opaque-document`'
      }
    />,
  );
  expect(container.querySelector('pre code')).toHaveTextContent(
    'file:opaque-document',
  );
  expect(screen.getAllByRole('button')).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Download file' }));
  expect(dispatch).toHaveBeenCalledWith({
    type: 'files.resolve',
    commandId: expect.any(String) as string,
    chatId: 'chat-a',
    fileId: 'opaque-document',
  });
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
});
it('resolves only an opaque file ID over the authenticated manager and navigates to its short lived download', async () => {
  let finish!: (value: {
    file: typeof file;
    download: { url: string; expiresAt: number };
  }) => void;
  const dispatch = vi.fn(
    () =>
      new Promise<{
        file: typeof file;
        download: { url: string; expiresAt: number };
      }>((resolve) => {
        finish = resolve;
      }),
  );
  registerApplicationDispatcher(dispatch);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.getAttribute('href')).toBe(`/downloads/${'a'.repeat(64)}`);
      expect(this.download).toBe('review.txt');
    });
  render(
    <AgentMessageContent
      chatId="chat-a"
      text="[Download review](file:opaque-document)"
    />,
  );
  const button = screen.getByRole('button', { name: 'Download review' });
  await userEvent.click(button);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
  expect(dispatch).toHaveBeenCalledWith({
    type: 'files.resolve',
    commandId: expect.any(String) as string,
    chatId: 'chat-a',
    fileId: 'opaque-document',
  });
  await act(async () => {
    await Promise.resolve();
    finish({
      file,
      download: {
        url: `/downloads/${'a'.repeat(64)}`,
        expiresAt: Date.now() + 60000,
      },
    });
  });
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(fetcher).not.toHaveBeenCalled();
  expect(button).toBeEnabled();
});
it.each([
  'sandbox:/home/node/.openclaw/workspace/documents/review.txt',
  '/home/node/.openclaw/workspace/documents/review.txt',
  '../other-agent/private.txt',
  'documents/review.txt',
])(
  'never sends native reference %s to a resolver or browser navigation',
  (href) => {
    const dispatch = vi.fn();
    registerApplicationDispatcher(dispatch);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(
      <AgentMessageContent
        chatId="chat-a"
        text={`[Download review](${href})`}
      />,
    );
    expect(screen.getByText('Download review').closest('a')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it('shows a manager resolution error without navigating', async () => {
  registerApplicationDispatcher(
    vi
      .fn()
      .mockRejectedValue(
        new Error('This file is not available in this conversation.'),
      ),
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined);
  render(
    <AgentMessageContent
      chatId="chat-a"
      text="[Download](file:opaque-document)"
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Download' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This file is not available in this conversation.',
  );
  expect(click).not.toHaveBeenCalled();
});
it('rejects nonapplication download URLs returned by a malformed result', async () => {
  registerApplicationDispatcher(
    vi.fn().mockResolvedValue({
      file,
      download: {
        url: 'https://untrusted.example/file',
        expiresAt: Date.now() + 60000,
      },
    }),
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined);
  render(
    <AgentMessageContent
      chatId="chat-a"
      text="[Download](file:opaque-document)"
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Download' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This file could not be downloaded.',
  );
  expect(click).not.toHaveBeenCalled();
});
it('does not fetch files or images on render and keeps external links unchanged', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(
    <AgentMessageContent
      chatId="chat-a"
      text="[Document](file:opaque-document) [Website](https://example.com) [Unsafe](javascript:alert(1))\n\n![Remote](https://example.com/image.png)"
    />,
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Website' })).toHaveAttribute(
    'target',
    '_blank',
  );
  expect(screen.getByText('Unsafe').closest('a')).toBeNull();
  expect(document.querySelector('img')).toBeNull();
});
it('ignores a late resolution after the active chat changes', async () => {
  let finish!: (value: unknown) => void;
  const dispatch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  registerApplicationDispatcher(dispatch as never);
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined);
  const { rerender } = render(
    <AgentMessageContent
      chatId="chat-a"
      text="[Download](file:opaque-document)"
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Download' }));
  rerender(
    <AgentMessageContent
      chatId="chat-b"
      text="[Download](file:opaque-document)"
    />,
  );
  await act(async () => {
    await Promise.resolve();
    finish({
      file,
      download: {
        url: `/downloads/${'b'.repeat(64)}`,
        expiresAt: Date.now() + 60000,
      },
    });
  });
  expect(click).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
});
it('rejects native paths in browser catalog metadata', () => {
  expect(artifactValid(file)).toBe(true);
  for (const sourcePath of [
    '/home/node/private.txt',
    '../private.txt',
    'documents/../../secret',
    'documents/.private',
    'documents\\private.txt',
    'documents//file.txt',
    'documents/\u0000.txt',
    '',
  ])
    expect(artifactValid({ ...file, sourcePath })).toBe(false);
});
