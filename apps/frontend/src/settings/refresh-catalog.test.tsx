import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ManagerCommand, ManagerResultData } from '@messenger/contracts';
import { registerApplicationDispatcher } from '../lib/manager';
import {
  useChatProjection,
  useModelCatalog,
  usePreferences,
} from '../state/stores';
import { models, snapshot } from '../test/fixtures';
import { chooseOption } from '../test/select';
import { ChatSettingsPanel } from './ChatSettingsPanel';
import { SettingsPage } from './SettingsPage';
vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}));
vi.mock('../conversation/ConnectionProvider', () => ({
  useConversation: () => vi.fn(),
}));
beforeEach(() => {
  useChatProjection.getState().clear();
  useChatProjection.getState().mergeChat(snapshot.chat);
  useModelCatalog.getState().clear();
  usePreferences.getState().clear();
});
for (const view of ['agent', 'application'] as const) {
  it(`${view} settings can explicitly refresh an empty cached catalog without losing edits`, async () => {
    const commands: ManagerCommand[] = [];
    registerApplicationDispatcher((command) => {
      commands.push(command);
      const result: ManagerResultData =
        command.type === 'models.list'
          ? { models: command.cachedOnly === false ? models : [] }
          : command.type === 'preferences.get'
            ? {
                preferences: {
                  defaults: snapshot.chat.settings,
                  busySendBehavior: 'queue',
                  version: 1,
                },
              }
            : { chat: snapshot.chat };
      return Promise.resolve(result);
    });
    render(
      <MemoryRouter>
        {view === 'agent' ? (
          <ChatSettingsPanel snapshot={snapshot} onClose={vi.fn()} />
        ) : (
          <SettingsPage />
        )}
      </MemoryRouter>,
    );
    const refresh = await screen.findByRole('button', {
      name: 'Refresh latest values and models, keep my edits',
    });
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(
      commands.filter((command) => command.type === 'models.list'),
    ).toEqual([
      expect.objectContaining({ type: 'models.list', cachedOnly: true }),
    ]);
    const field =
      view === 'agent'
        ? screen.getByLabelText('Conversation name')
        : screen.getByLabelText('Custom instructions');
    await userEvent.clear(field);
    await userEvent.type(field, 'Keep this unsaved edit');
    await userEvent.click(refresh);
    await waitFor(() =>
      expect(
        commands.filter((command) => command.type === 'models.list'),
      ).toHaveLength(2),
    );
    expect(
      commands.filter((command) => command.type === 'models.list')[1],
    ).toMatchObject({ cachedOnly: false });
    expect(field).toHaveValue('Keep this unsaved edit');
    await chooseOption(
      screen.getByRole('combobox', { name: 'Model' }),
      'model-b',
    );
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveAttribute(
      'data-value',
      'model-b',
    );
  });
}
