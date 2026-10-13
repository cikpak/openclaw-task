import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type {
  ChatSettings,
  ChatSnapshot,
  ChatSummary,
} from '@messenger/contracts';
import {
  useChatProjection,
  useModelCatalog,
  useNotices,
} from '../state/stores';
import { models, snapshot } from '../test/fixtures';
import { chooseOption } from '../test/select';
import { ChatSettingsPanel } from './ChatSettingsPanel';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../conversation/ConnectionProvider', () => ({
  useConversation: () => send,
}));
beforeEach(() => {
  useChatProjection.getState().clear();
  useModelCatalog.getState().clear();
  useNotices.setState({ notices: [] });
  send.mockResolvedValue({});
});
function response(data: unknown, version = 1, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ETag: `"${version}"` },
  });
}
function fixture(
  options: {
    occupied?: boolean;
    unknown?: boolean;
    deferred?: boolean;
    unavailableModel?: boolean;
  } = {},
) {
  let latest: ChatSummary = {
    ...snapshot.chat,
    settings: {
      ...snapshot.chat.settings,
      customInstructions: 'Initial instructions',
      responseStyle: 'detailed',
      personality: 'professional',
    },
  };
  const current: ChatSnapshot = {
    ...snapshot,
    chat: latest,
    activeRun: options.occupied ? { id: 'run-1', sequence: 1, text: '' } : null,
    pendingSettings: options.unknown
      ? {
          id: 'op-1',
          settings: latest.settings,
          status: 'unknown',
          policy: 'when-idle',
        }
      : null,
  };
  const writes: { url: string; options: RequestInit }[] = [];
  let fail = false;
  let finishRead!: (value: Response) => void;
  const read = new Promise<Response>((resolve) => {
    finishRead = resolve;
  });
  let firstRead = options.deferred;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, requestOptions: RequestInit = {}) => {
      if (
        requestOptions.method === 'PATCH' ||
        requestOptions.method === 'POST'
      ) {
        writes.push({ url, options: requestOptions });
        if (fail)
          return Promise.resolve(
            response(
              { detail: 'This resource changed. Reload before saving.' },
              latest.version,
              412,
            ),
          );
        if (url.endsWith('/settings')) {
          const input = JSON.parse(requestOptions.body as string) as {
            settings: ChatSettings;
          };
          latest = {
            ...latest,
            settings: input.settings,
            version: latest.version + 1,
          };
          return Promise.resolve(
            response(
              {
                effective: latest.settings,
                pending: null,
                version: latest.version,
              },
              latest.version,
              202,
            ),
          );
        }
        if (url === '/api/chats/chat-a') {
          const input = JSON.parse(requestOptions.body as string) as {
            name: string;
          };
          latest = { ...latest, name: input.name, version: latest.version + 1 };
        }
        return Promise.resolve(response(latest, latest.version));
      }
      if (url === '/api/chats/chat-a') {
        if (firstRead) {
          firstRead = false;
          return read;
        }
        return Promise.resolve(response(latest, latest.version));
      }
      return Promise.resolve(
        response({
          models: options.unavailableModel
            ? models.map((model) =>
                model.id === latest.settings.model
                  ? { ...model, available: false }
                  : model,
              )
            : models,
        }),
      );
    }),
  );
  const onClose = vi.fn();
  render(<ChatSettingsPanel snapshot={current} onClose={onClose} />);
  return {
    writes,
    onClose,
    failSave() {
      fail = true;
    },
    updateSaved(name: string, settings = latest.settings) {
      latest = { ...latest, name, settings, version: latest.version + 1 };
    },
    completeRead() {
      finishRead(response(latest, latest.version));
    },
  };
}
async function ready() {
  await waitFor(() =>
    expect(screen.getByLabelText('Custom instructions')).toBeEnabled(),
  );
}

it('disables a clean Save without disabling controls, and recognizes reverted behavior and names', async () => {
  const { writes } = fixture();
  await ready();
  const save = screen.getByRole('button', { name: 'Save changes' });
  expect(save).toBeDisabled();
  expect(screen.getByLabelText('Custom instructions')).toHaveValue(
    'Initial instructions',
  );
  await chooseOption(screen.getByLabelText('Personality'), 'direct');
  expect(save).toBeEnabled();
  await chooseOption(screen.getByLabelText('Personality'), 'professional');
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Conversation name'), {
    target: { value: 'Changed' },
  });
  expect(save).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Conversation name'), {
    target: { value: ' Research ' },
  });
  expect(save).toBeDisabled();
  expect(writes).toHaveLength(0);
});

it('sends behavior and model fields together, updates the baseline, and honestly reports acceptance', async () => {
  const { writes, onClose } = fixture();
  await ready();
  fireEvent.change(screen.getByLabelText('Custom instructions'), {
    target: { value: 'New instructions' },
  });
  await chooseOption(screen.getByLabelText('Response style'), 'concise');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(writes).toHaveLength(1);
  expect(writes[0]?.url).toBe('/api/chats/chat-a/settings');
  expect(JSON.parse(writes[0]!.options.body as string)).toMatchObject({
    policy: 'when-idle',
    settings: {
      model: 'model-a',
      customInstructions: 'New instructions',
      responseStyle: 'concise',
      personality: 'professional',
    },
  });
  expect(useNotices.getState().notices[0]?.text).toMatch(/change accepted/);
});

it.each(['when-idle', 'cancel-work'] as const)(
  'uses %s policy for behavioral changes during active work',
  async (policy) => {
    const { writes } = fixture({ occupied: true });
    await ready();
    await chooseOption(screen.getByLabelText('Personality'), 'friendly');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(writes).toHaveLength(0);
    await userEvent.click(
      screen.getByRole('button', {
        name:
          policy === 'when-idle'
            ? 'Apply when all work is idle'
            : 'Cancel active and queued work, then apply',
      }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    const input = JSON.parse(writes[0]!.options.body as string) as {
      policy: string;
    };
    expect(input.policy).toBe(policy);
  },
);

it('renames without unnecessary native settings changes or cancelling active work', async () => {
  const { writes } = fixture({ occupied: true });
  await ready();
  fireEvent.change(screen.getByLabelText('Conversation name'), {
    target: { value: 'Renamed' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.url).toBe('/api/chats/chat-a');
  expect(useNotices.getState().notices[0]?.text).toBe(
    'Conversation name saved.',
  );
});

it('blocks behavior changes on an unavailable model until a valid model is selected', async () => {
  const { writes } = fixture({ occupied: true, unavailableModel: true });
  await ready();
  const save = screen.getByRole('button', { name: 'Save changes' });
  fireEvent.change(screen.getByLabelText('Conversation name'), {
    target: { value: 'Renamed' },
  });
  expect(save).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Custom instructions'), {
    target: { value: 'Changed guidance' },
  });
  expect(save).toBeDisabled();
  await chooseOption(screen.getByLabelText('Model'), 'model-b');
  expect(save).toBeEnabled();
  expect(writes).toHaveLength(0);
});

it('sends only the rename request for an unavailable saved model during active work', async () => {
  const { writes } = fixture({ occupied: true, unavailableModel: true });
  await ready();
  fireEvent.change(screen.getByLabelText('Conversation name'), {
    target: { value: 'Renamed' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.url).toBe('/api/chats/chat-a');
  expect(
    screen.queryByRole('button', {
      name: 'Cancel active and queued work, then apply',
    }),
  ).not.toBeInTheDocument();
  expect(useNotices.getState().notices[0]?.text).toBe(
    'Conversation name saved.',
  );
});

it('keeps drafts after failure and adopts concurrent rename/version without overwriting it', async () => {
  const state = fixture();
  await ready();
  state.failSave();
  fireEvent.change(screen.getByLabelText('Custom instructions'), {
    target: { value: 'My draft' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await screen.findByText('This resource changed. Reload before saving.');
  state.updateSaved('Renamed elsewhere', {
    ...snapshot.chat.settings,
    customInstructions: 'Other saved instructions',
    responseStyle: 'concise',
    personality: 'neutral',
  });
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Refresh latest values and models, keep my edits',
    }),
  );
  await screen.findByText(/Latest saved values: Renamed elsewhere/);
  expect(screen.getByLabelText('Conversation name')).toHaveValue(
    'Renamed elsewhere',
  );
  expect(screen.getByLabelText('Custom instructions')).toHaveValue('My draft');
  fireEvent.change(screen.getByLabelText('Custom instructions'), {
    target: { value: 'Other saved instructions' },
  });
  await chooseOption(screen.getByLabelText('Response style'), 'concise');
  await chooseOption(screen.getByLabelText('Personality'), 'neutral');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
});

it('leaves recovery actions available on a clean form with an unknown pending change', async () => {
  fixture({ unknown: true });
  await ready();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Retry pending change' }),
  ).toBeEnabled();
  expect(
    screen.getByRole('button', { name: 'Discard pending change' }),
  ).toBeEnabled();
});

it('blocks loading, blank names and oversized instruction submissions', async () => {
  const state = fixture({ deferred: true });
  expect(screen.getByLabelText('Custom instructions')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  state.completeRead();
  await ready();
  fireEvent.change(screen.getByLabelText('Conversation name'), {
    target: { value: ' ' },
  });
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Conversation name'), {
    target: { value: 'Research' },
  });
  fireEvent.change(screen.getByLabelText('Custom instructions'), {
    target: { value: 'x'.repeat(8001) },
  });
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  expect(state.writes).toHaveLength(0);
});
