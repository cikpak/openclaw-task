import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type {
  BrowserFile,
  ManagerCommand,
  ManagerResultData,
} from '@messenger/contracts';
import { registerApplicationDispatcher } from '../lib/manager';
import { useChatProjection } from '../state/stores';
import { ArtifactCatalog } from './Artifacts';

it('renders more than 100 deliverables and 200 retained inputs and downloads an input through an opaque manager permission', async () => {
  useChatProjection.getState().clear();
  const files = (
    count: number,
    category: BrowserFile['category'],
  ): BrowserFile[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `${category}-${index}`,
      name: `${category}-${index}.txt`,
      mimeType: 'text/plain',
      sizeBytes: index + 1,
      category,
      updatedAt: 1,
    }));
  const inputs = files(200, 'input');
  const deliverables = files(101, 'deliverable');
  const url = `/downloads/${'a'.repeat(64)}`;
  const dispatcher = vi.fn(
    (command: ManagerCommand): Promise<ManagerResultData> => {
      if (command.type === 'files.list')
        return Promise.resolve({
          files: command.category === 'shared' ? inputs : deliverables,
        });
      if (command.type === 'files.resolve')
        return Promise.resolve({
          file: inputs.find((file) => file.id === command.fileId)!,
          download: { url, expiresAt: Date.now() + 60000 },
        });
      return Promise.reject(new Error('Unexpected application command'));
    },
  );
  registerApplicationDispatcher(dispatcher);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.getAttribute('href')).toBe(url);
      expect(this.download).toBe('input-199.txt');
    });
  render(<ArtifactCatalog chatId="chat-a" />);
  expect(dispatcher).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole('button', { name: 'Conversation files' }),
  );
  await waitFor(() =>
    expect(
      within(screen.getByRole('region', { name: 'From agent' })).getAllByRole(
        'button',
      ),
    ).toHaveLength(101),
  );
  expect(
    within(
      screen.getByRole('region', { name: 'Shared with agent' }),
    ).getAllByRole('button'),
  ).toHaveLength(200);
  expect(
    screen.getByRole('button', { name: /deliverable-100.txt/u }),
  ).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: /input-199.txt/u }));
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(dispatcher).toHaveBeenLastCalledWith({
    type: 'files.resolve',
    commandId: expect.any(String) as string,
    chatId: 'chat-a',
    fileId: 'input-199',
  });
  expect(fetcher).not.toHaveBeenCalled();
});
