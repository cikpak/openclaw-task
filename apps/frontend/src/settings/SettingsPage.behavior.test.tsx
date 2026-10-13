import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Preferences } from '@messenger/contracts';
import { useModelCatalog, useNotices, usePreferences } from '../state/stores';
import { models, snapshot } from '../test/fixtures';
import { chooseOption } from '../test/select';
import { SettingsPage } from './SettingsPage';

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}));
beforeEach(() => {
  useModelCatalog.getState().clear();
  usePreferences.getState().clear();
  useNotices.setState({ notices: [] });
});
function response(data: unknown, version = 1, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ETag: `"${version}"` },
  });
}
function fixture() {
  let latest: Preferences = {
    defaults: {
      ...snapshot.chat.settings,
      customInstructions: 'Initial instructions',
      responseStyle: 'detailed',
      personality: 'professional',
    },
    busySendBehavior: 'queue',
    version: 1,
  };
  let fail = false;
  const writes: {
    defaults: Preferences['defaults'];
    busySendBehavior: 'queue' | 'steer';
  }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options: RequestInit = {}) => {
      if (options.method === 'PATCH') {
        const input = JSON.parse(options.body as string) as Omit<
          Preferences,
          'version'
        >;
        writes.push(input);
        if (fail)
          return Promise.resolve(
            response(
              { detail: 'Concurrent edit. Refresh latest values.' },
              latest.version,
              412,
            ),
          );
        latest = { ...input, version: latest.version + 1 };
        return Promise.resolve(response(latest, latest.version));
      }
      return Promise.resolve(
        response(url === '/api/models' ? { models } : latest, latest.version),
      );
    }),
  );
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
  return {
    writes,
    failSave() {
      fail = true;
    },
    updateSaved(defaults: Preferences['defaults']) {
      latest = { ...latest, defaults, version: latest.version + 1 };
    },
  };
}
async function ready() {
  await waitFor(() =>
    expect(screen.getByLabelText('Custom instructions')).toBeEnabled(),
  );
}

it('keeps clean controls editable while Save is disabled and establishes a saved baseline', async () => {
  const { writes } = fixture();
  expect(
    screen.getByRole('button', { name: 'Save preferences' }),
  ).toBeDisabled();
  await ready();
  const save = screen.getByRole('button', { name: 'Save preferences' });
  expect(save).toBeDisabled();
  expect(screen.getByLabelText('Custom instructions')).toHaveValue(
    'Initial instructions',
  );
  expect(screen.getByText(/Copied into new agents only/)).toBeInTheDocument();
  await chooseOption(screen.getByLabelText('Response style'), 'concise');
  await chooseOption(screen.getByLabelText('Personality'), 'friendly');
  expect(save).toBeEnabled();
  await userEvent.click(save);
  await waitFor(() => expect(save).toBeDisabled());
  expect(writes).toHaveLength(1);
  expect(writes[0]?.defaults).toMatchObject({
    customInstructions: 'Initial instructions',
    responseStyle: 'concise',
    personality: 'friendly',
  });
  expect(useNotices.getState().notices[0]?.text).toBe('Preferences saved.');
  await userEvent.click(save);
  expect(writes).toHaveLength(1);
});

it('returns to clean after reverting text, presets and send behavior', async () => {
  const { writes } = fixture();
  await ready();
  const save = screen.getByRole('button', { name: 'Save preferences' });
  fireEvent.change(screen.getByLabelText('Custom instructions'), {
    target: { value: 'Changed' },
  });
  expect(save).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Custom instructions'), {
    target: { value: 'Initial instructions' },
  });
  await chooseOption(screen.getByLabelText('Response style'), 'default');
  await chooseOption(screen.getByLabelText('Response style'), 'detailed');
  await chooseOption(screen.getByLabelText('Default send behavior'), 'steer');
  expect(save).toBeEnabled();
  await chooseOption(screen.getByLabelText('Default send behavior'), 'queue');
  expect(save).toBeDisabled();
  expect(writes).toHaveLength(0);
});

it('keeps failed drafts and refreshes the baseline without overwriting them', async () => {
  const fixtureState = fixture();
  await ready();
  fixtureState.failSave();
  fireEvent.change(screen.getByLabelText('Custom instructions'), {
    target: { value: 'My draft' },
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Save preferences' }),
  );
  await screen.findByText('Concurrent edit. Refresh latest values.');
  fixtureState.updateSaved({
    ...snapshot.chat.settings,
    customInstructions: 'Changed elsewhere',
    responseStyle: 'concise',
    personality: 'neutral',
  });
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Refresh latest values and models, keep my edits',
    }),
  );
  await screen.findByText(/Latest saved defaults/);
  expect(screen.getByLabelText('Custom instructions')).toHaveValue('My draft');
  expect(
    screen.getByRole('button', { name: 'Save preferences' }),
  ).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Custom instructions'), {
    target: { value: 'Changed elsewhere' },
  });
  await chooseOption(screen.getByLabelText('Response style'), 'concise');
  await chooseOption(screen.getByLabelText('Personality'), 'neutral');
  expect(
    screen.getByRole('button', { name: 'Save preferences' }),
  ).toBeDisabled();
});

it('refuses oversized values even if a synthetic event bypasses the textarea limit', async () => {
  const { writes } = fixture();
  await ready();
  fireEvent.change(screen.getByLabelText('Custom instructions'), {
    target: { value: 'x'.repeat(8001) },
  });
  expect(
    screen.getByRole('button', { name: 'Save preferences' }),
  ).toBeDisabled();
  expect(writes).toHaveLength(0);
});
