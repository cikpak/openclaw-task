import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ArtifactLinks } from './Artifacts';
import { registerApplicationDispatcher } from '../lib/manager';

it('keeps the complete long filename accessible and makes the size part of the authenticated download button', async () => {
  const name =
    'downloaded-report-with-a-very-long-filename-that-needs-to-be-truncated-in-the-files-sidebar.txt';
  const artifact = {
    id: 'opaque-long-report',
    name,
    mimeType: 'text/plain',
    sizeBytes: 1536,
    category: 'deliverable' as const,
    updatedAt: 1,
  };
  const dispatch = vi.fn().mockResolvedValue({
    file: artifact,
    download: {
      url: `/downloads/${'a'.repeat(64)}`,
      expiresAt: Date.now() + 60000,
    },
  });
  registerApplicationDispatcher(dispatch);
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe(name);
      expect(this.getAttribute('href')).toBe(`/downloads/${'a'.repeat(64)}`);
    });
  render(<ArtifactLinks chatId="chat-a" artifacts={[artifact]} />);
  const card = screen.getByRole('button', { name: `Download ${name} (2 KB)` });
  expect(card).toHaveAttribute('title', name);
  expect(within(card).getByText(name)).toHaveAttribute('title', name);
  expect(card.querySelector('svg')).toBeInTheDocument();
  // The metadata belongs to the same button, so clicking it downloads the file too.
  await userEvent.click(within(card).getByText('2 KB'));
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({
    type: 'files.resolve',
    commandId: expect.any(String) as string,
    chatId: 'chat-a',
    fileId: artifact.id,
  });
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(card).toBeEnabled();
});
