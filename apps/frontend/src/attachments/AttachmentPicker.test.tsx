import type { ManagerCommand } from '@messenger/contracts';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AttachmentPicker } from './AttachmentPicker';
import { registerApplicationDispatcher } from '../lib/manager';
const uploaded = {
  uploadId: 'upload',
  name: 'notes.md',
  mimeType: 'text/markdown',
  size: 6,
};
it('normalizes empty Markdown MIME and uploads bounded chunks with acknowledged offsets', async () => {
  const onChange = vi.fn();
  const dispatch = vi.fn(async (command: ManagerCommand) => {
    await Promise.resolve();
    if (command.type === 'upload.begin') return { uploadId: 'upload' };
    if (command.type === 'upload.chunk')
      return { nextOffset: command.offset + atob(command.base64).length };
    return { upload: uploaded };
  });
  registerApplicationDispatcher(dispatch);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<AttachmentPicker attachments={[]} onChange={onChange} />);
  await userEvent.upload(
    screen.getByLabelText('Attach files'),
    new File(['Hello!'], 'notes.md', { type: '' }),
  );
  await waitFor(() => expect(onChange).toHaveBeenCalledWith([uploaded]));
  expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual([
    'upload.begin',
    'upload.chunk',
    'upload.complete',
  ]);
  expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
    name: 'notes.md',
    mimeType: 'text/markdown',
    size: 6,
  });
  expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
    uploadId: 'upload',
    offset: 0,
    base64: btoa('Hello!'),
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it('keeps the upload label stable and spins only the attachment being removed', async () => {
  let finish!: (value: { uploadId?: string }) => void;
  const items = [
    { uploadId: 'one', name: 'one.txt', mimeType: 'text/plain', size: 1 },
    { uploadId: 'two', name: 'two.txt', mimeType: 'text/plain', size: 1 },
  ];
  const dispatch = vi.fn(async (command: ManagerCommand) => {
    await Promise.resolve();
    if (command.type === 'upload.begin' || command.type === 'upload.remove')
      return new Promise<{ uploadId?: string }>((resolve) => {
        finish = resolve;
      });
    if (command.type === 'upload.chunk') return { nextOffset: 1 };
    return { upload: items[0] };
  });
  registerApplicationDispatcher(dispatch);
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
  expect(dispatch).toHaveBeenCalledOnce();
  await act(async () => {
    await Promise.resolve();
    finish({ uploadId: 'one' });
  });
  await waitFor(() =>
    expect(screen.getByLabelText('Attach files')).toBeEnabled(),
  );
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
  expect(
    dispatch.mock.calls.filter(([command]) => command.type === 'upload.remove'),
  ).toHaveLength(1);
  await act(async () => {
    await Promise.resolve();
    finish({});
  });
  expect(onChange).toHaveBeenLastCalledWith([items[1]]);
});
it('rejects too many files before dispatching any manager command', async () => {
  const dispatch = vi.fn();
  registerApplicationDispatcher(dispatch);
  render(<AttachmentPicker attachments={[]} onChange={() => undefined} />);
  await userEvent.upload(
    screen.getByLabelText('Attach files'),
    Array.from(
      { length: 6 },
      (_, index) => new File(['x'], `note${index}.txt`, { type: 'text/plain' }),
    ),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('up to 5 files');
  expect(dispatch).not.toHaveBeenCalled();
});
