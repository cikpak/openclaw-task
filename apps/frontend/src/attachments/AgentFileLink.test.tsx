import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AgentMessageContent } from '../conversation/AgentMessageContent';
import { artifactValid } from '../lib/validation';

const artifact = {
  id: 'opaque-document',
  name: 'review.txt',
  mimeType: 'text/plain',
  sizeBytes: 4,
  sourcePath: 'documents/review.txt',
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

it('resolves a local file within its chat and downloads authenticated bytes without opening a model URL', async () => {
  let finish: (value: Response) => void = () => undefined;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(new Response('data'));
  vi.stubGlobal('fetch', fetch);
  const create = vi
    .spyOn(URL, 'createObjectURL')
    .mockReturnValue('blob:download');
  const revoke = vi
    .spyOn(URL, 'revokeObjectURL')
    .mockImplementation(() => undefined);
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined);
  render(
    <AgentMessageContent
      chatId="chat-a"
      text="[Download review](documents/review.txt)"
    />,
  );
  const button = screen.getByRole('button', { name: 'Download review' });
  await userEvent.click(button);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe(
    '/api/chats/chat-a/artifacts/resolve?path=documents%2Freview.txt',
  );
  await act(async () => {
    finish(response({ artifact }));
    await Promise.resolve();
  });
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(fetch.mock.calls[1]?.[0]).toBe(
    '/api/chats/chat-a/artifacts/opaque-document',
  );
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({
    credentials: 'same-origin',
  });
  expect(create).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith('blob:download');
  expect(button).toBeEnabled();
});

it.each([
  'sandbox:/home/node/.openclaw/workspace/messenger-chat-a/documents/review.txt',
  '/home/node/.openclaw/workspace/messenger-chat-a/documents/review.txt',
  '../other-agent/private.txt',
])(
  'sends local reference %s only to the authenticated resolver and fails visibly without navigating',
  async (href) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        response(
          { detail: 'This file is not available in this conversation.' },
          404,
        ),
      );
    vi.stubGlobal('fetch', fetch);
    render(
      <AgentMessageContent
        chatId="chat-a"
        text={`[Download review](${href})`}
      />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Download review' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This file is not available in this conversation.',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `/api/chats/chat-a/artifacts/resolve?path=${encodeURIComponent(href)}`,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  },
);

it('does not fetch files or external images on render and keeps external links unchanged', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(
    <AgentMessageContent
      chatId="chat-a"
      text="[Document](documents/review.txt) [Website](https://example.com) [Unsafe](javascript:alert(1))\n\n![Remote](https://example.com/image.png)"
    />,
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Website' })).toHaveAttribute(
    'target',
    '_blank',
  );
  expect(screen.getByText('Unsafe').closest('a')).toBeNull();
  expect(document.querySelector('img')).toBeNull();
});

it('aborts a pending download on chat changes and never transfers the old response into the next chat', async () => {
  let finish: (value: Response) => void = () => undefined;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const { rerender } = render(
    <AgentMessageContent
      chatId="chat-a"
      text="[Download](documents/review.txt)"
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Download' }));
  const signal = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
    .signal!;
  rerender(
    <AgentMessageContent
      chatId="chat-b"
      text="[Download](documents/review.txt)"
    />,
  );
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish(response({ artifact }));
    await Promise.resolve();
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
});

it('rejects leaked absolute, hidden, traversal and malformed paths in file catalog metadata', () => {
  expect(artifactValid(artifact)).toBe(true);
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
    expect(artifactValid({ ...artifact, sourcePath })).toBe(false);
});
