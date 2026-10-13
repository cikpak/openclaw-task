import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import type { ChatSettings } from '@messenger/contracts';
import {
  chatSettingsEqual,
  chatSettingsSupported,
} from '../lib/agent-behavior';
import { models, snapshot } from '../test/fixtures';
import { chooseOption } from '../test/select';
import { AgentBehaviorControls } from './AgentBehaviorControls';
import { ModelControls } from './ModelControls';

it('loads compatible defaults and preserves instructions across preset and model changes', async () => {
  function Form() {
    const [value, setValue] = useState<ChatSettings>(snapshot.chat.settings);
    return (
      <>
        <ModelControls models={models} value={value} onChange={setValue} />
        <AgentBehaviorControls value={value} onChange={setValue} />
      </>
    );
  }
  render(<Form />);
  expect(screen.getByLabelText('Response style')).toHaveAttribute(
    'data-value',
    'default',
  );
  expect(screen.getByLabelText('Personality')).toHaveAttribute(
    'data-value',
    'neutral',
  );
  const textarea = screen.getByLabelText('Custom instructions');
  expect(textarea).toHaveAttribute('maxlength', '8000');
  expect(textarea).toHaveAttribute('aria-describedby');
  await userEvent.type(textarea, 'Explain your decisions.');
  await chooseOption(screen.getByLabelText('Response style'), 'concise');
  await chooseOption(screen.getByLabelText('Personality'), 'friendly');
  await chooseOption(screen.getByLabelText('Model'), 'model-b');
  expect(textarea).toHaveValue('Explain your decisions.');
  expect(screen.getByLabelText('Response style')).toHaveAttribute(
    'data-value',
    'concise',
  );
  expect(screen.getByLabelText('Personality')).toHaveAttribute(
    'data-value',
    'friendly',
  );
  expect(screen.getByText('23 / 8,000')).toBeInTheDocument();
});

it('uses the shared keyboard selector and preserves the other behavioral fields', async () => {
  function Form() {
    const [value, setValue] = useState<ChatSettings>({
      ...snapshot.chat.settings,
      customInstructions: 'Keep this',
      personality: 'direct',
    });
    return <AgentBehaviorControls value={value} onChange={setValue} />;
  }
  render(<Form />);
  screen.getByLabelText('Response style').focus();
  await userEvent.keyboard('{ArrowDown}');
  await userEvent.keyboard('{End}{Enter}');
  expect(screen.getByLabelText('Response style')).toHaveAttribute(
    'data-value',
    'detailed',
  );
  expect(screen.getByLabelText('Personality')).toHaveAttribute(
    'data-value',
    'direct',
  );
  expect(screen.getByLabelText('Custom instructions')).toHaveValue('Keep this');
});

it('keeps the textarea and selectors disabled while loading or saving', () => {
  render(
    <AgentBehaviorControls
      value={snapshot.chat.settings}
      onChange={() => {}}
      disabled
    />,
  );
  expect(screen.getByLabelText('Custom instructions')).toBeDisabled();
  expect(screen.getByLabelText('Response style')).toBeDisabled();
  expect(screen.getByLabelText('Personality')).toBeDisabled();
});

it('shows stable counted limits for loaded instructions', () => {
  render(
    <AgentBehaviorControls
      value={{
        ...snapshot.chat.settings,
        customInstructions: 'x'.repeat(8000),
      }}
      onChange={() => {}}
    />,
  );
  expect(screen.getByText('8,000 / 8,000')).toBeInTheDocument();
  fireEvent.focus(screen.getByLabelText('Custom instructions'));
  expect(screen.getByText('8,000 / 8,000')).toBeInTheDocument();
});

it('treats legacy absent fields as defaults and validates model capabilities and limits', () => {
  const current = snapshot.chat.settings;
  expect(
    chatSettingsEqual(current, {
      ...current,
      customInstructions: '',
      responseStyle: 'default',
      personality: 'neutral',
    }),
  ).toBe(true);
  expect(
    chatSettingsEqual(current, { ...current, personality: 'professional' }),
  ).toBe(false);
  expect(chatSettingsEqual(current, { ...current, thinkingLevel: 'low' })).toBe(
    false,
  );
  expect(chatSettingsSupported(current, models)).toBe(true);
  expect(
    chatSettingsSupported(
      { ...current, customInstructions: 'x'.repeat(8001) },
      models,
    ),
  ).toBe(false);
  expect(
    chatSettingsSupported({ ...current, thinkingLevel: 'unsupported' }, models),
  ).toBe(false);
  expect(
    chatSettingsSupported(
      { ...current, model: 'model-b', thinkingLevel: 'off' },
      models,
    ),
  ).toBe(false);
});
