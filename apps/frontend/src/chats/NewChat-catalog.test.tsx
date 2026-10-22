import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type { ManagerCommand, ManagerResultData } from '@messenger/contracts';
import { NewChat } from './NewChat';
import { registerApplicationDispatcher } from '../lib/manager';
import { usePreferences } from '../state/stores';
import { models, snapshot } from '../test/fixtures';
let dispose: (() => void) | undefined;
afterEach(() => dispose?.());
it('blocks a preserved model choice when refreshed native capabilities no longer support it', async () => {
  usePreferences.getState().clear();
  let reads = 0;
  const original = models[0]!;
  const replacement = {
    ...original,
    id: 'new-provider/new-model',
    name: 'Replacement',
  };
  const send = vi.fn((command: ManagerCommand): Promise<ManagerResultData> => {
    if (command.type === 'models.list')
      return Promise.resolve({
        models: ++reads === 1 ? [original] : [replacement],
      });
    if (command.type === 'preferences.get')
      return Promise.resolve({
        preferences: {
          version: 1,
          busySendBehavior: 'queue',
          defaults: { ...snapshot.chat.settings, model: original.id },
        },
      });
    return Promise.resolve({});
  });
  dispose = registerApplicationDispatcher(send);
  render(
    <MemoryRouter>
      <NewChat onClose={() => {}} />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled(),
  );
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Refresh available models, keep my entries',
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled(),
  );
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'models.list', cachedOnly: true }),
  );
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'models.list', cachedOnly: false }),
  );
  expect(
    send.mock.calls.some(([command]) => command.type === 'chat.create'),
  ).toBe(false);
});
