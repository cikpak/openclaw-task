import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AttachmentPicker } from './AttachmentPicker';
it('normalizes an empty browser Markdown MIME type while retaining multipart boundaries', async () => {
  const onChange = vi.fn();
  let body: FormData | undefined;
  let headers: HeadersInit | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, options: RequestInit = {}) => {
      if (options.body instanceof FormData) body = options.body;
      headers = options.headers;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            uploadId: 'upload',
            name: 'notes.md',
            mimeType: 'text/markdown',
            size: 6,
          }),
          { status: 201 },
        ),
      );
    }),
  );
  render(<AttachmentPicker attachments={[]} onChange={onChange} />);
  await userEvent.upload(
    screen.getByLabelText('Attach files'),
    new File(['Hello!'], 'notes.md', { type: '' }),
  );
  await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  const file = body?.get('file');
  expect(file).toBeInstanceOf(File);
  if (!(file instanceof File)) throw new Error('File not uploaded');
  expect(file.type).toBe('text/markdown');
  expect(headers).toEqual({});
});
it('keeps the upload label stable and spins only the attachment being removed', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const items = [
    { uploadId: 'one', name: 'one.txt', mimeType: 'text/plain', size: 1 },
    { uploadId: 'two', name: 'two.txt', mimeType: 'text/plain', size: 1 },
  ];
  const onChange = vi.fn();
  const { rerender } = render(
    <AttachmentPicker attachments={[]} onChange={onChange} />,
  );
  await userEvent.upload(
    screen.getByLabelText('Attach files'),
    new File(['x'], 'new.txt', { type: 'text/plain' }),
  );
  expect(screen.getByLabelText('Attach files')).toBeDisabled();
  expect(screen.getByText('Attach files')).toHaveAttribute('aria-busy', 'true');
  expect(fetcher).toHaveBeenCalledOnce();
  await act(async () => {
    finish(new Response(JSON.stringify(items[0]), { status: 201 }));
    await Promise.resolve();
  });
  expect(screen.getByLabelText('Attach files')).toBeEnabled();
  rerender(<AttachmentPicker attachments={items} onChange={onChange} />);
  await userEvent.dblClick(
    screen.getByRole('button', { name: 'Remove one.txt' }),
  );
  expect(
    screen.getByRole('button', { name: 'Remove one.txt' }),
  ).toHaveAttribute('aria-busy', 'true');
  expect(
    screen.getByRole('button', { name: 'Remove two.txt' }),
  ).not.toHaveAttribute('aria-busy');
  expect(screen.getByRole('button', { name: 'Remove two.txt' })).toBeDisabled();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => {
    finish(new Response(null, { status: 204 }));
    await Promise.resolve();
  });
  expect(onChange).toHaveBeenLastCalledWith([items[1]]);
});
it('rejects too many files before making any network request', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<AttachmentPicker attachments={[]} onChange={() => undefined} />);
  await userEvent.upload(
    screen.getByLabelText('Attach files'),
    Array.from(
      { length: 6 },
      (_, index) => new File(['x'], `note${index}.txt`, { type: 'text/plain' }),
    ),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('up to 5 files');
  expect(fetcher).not.toHaveBeenCalled();
});
