import { chooseOption } from '../test/select';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { models, snapshot } from '../test/fixtures';
import { ModelControls, selectModel } from './ModelControls';
const base = models[0];
if (!base) throw new Error('fixture missing');
const reasoning = {
  ...base,
  id: 'reasoning',
  thinkingDefault: 'off',
  thinkingLevels: ['off', 'low', 'medium', 'high'].map((id) => ({
    id,
    label: id,
  })),
};
it('retains supported selections and resets unsupported thinking and Fast together', async () => {
  function Form() {
    const [value, setValue] = useState(snapshot.chat.settings);
    return (
      <>
        <ModelControls models={models} value={value} onChange={setValue} />
        <output>{JSON.stringify(value)}</output>
      </>
    );
  }
  render(<Form />);
  await chooseOption(screen.getByLabelText('Model'), 'model-b');
  expect(screen.getByLabelText('Thinking')).toHaveAttribute(
    'data-value',
    'off',
  );
  expect(screen.getByLabelText('Speed')).toHaveAttribute(
    'data-value',
    'standard',
  );
  expect(screen.getByLabelText('Speed')).toBeDisabled();
  expect(screen.getByText(/"fastMode":false/)).toBeVisible();
  expect(screen.getByText(/Thinking changed to Off/)).toBeVisible();
});
it('retains unavailable model and unsupported selections with explanatory labels', () => {
  render(
    <ModelControls
      models={models}
      value={{ model: 'removed', thinkingLevel: 'high', fastMode: true }}
      onChange={() => undefined}
    />,
  );
  expect(screen.getByLabelText('Model')).toHaveTextContent(
    'removed · unavailable',
  );
  expect(screen.getByLabelText('Thinking')).toHaveTextContent(
    'high · no longer supported',
  );
  expect(screen.getByLabelText('Thinking')).toBeDisabled();
  expect(screen.getByLabelText('Speed')).toHaveTextContent(
    'Fast · support unconfirmed',
  );
  expect(screen.getByLabelText('Speed')).toBeDisabled();
});
it('preserves compatible preferences when changing to the same model', () => {
  const model = models[0];
  if (!model) throw new Error('fixture missing');
  expect(selectModel(snapshot.chat.settings, model)).toEqual(
    snapshot.chat.settings,
  );
});
it.each([
  ['', '', 'medium'],
  ['unconfigured', 'off', 'medium'],
  ['other-model', 'high', 'medium'],
  ['reasoning', '', 'medium'],
  ['reasoning', 'unsupported', 'medium'],
  ['reasoning', 'off', 'off'],
  ['reasoning', 'low', 'low'],
  ['reasoning', 'high', 'high'],
])(
  'defaults %s/%s to %s without overwriting explicit current-model choices',
  (model, thinkingLevel, expected) => {
    expect(
      selectModel({ model, thinkingLevel, fastMode: false }, reasoning)
        .thinkingLevel,
    ).toBe(expected);
  },
);
it('uses a valid native fallback when medium is unsupported', () => {
  const native = { ...base, thinkingDefault: 'high' };
  const current = { model: '', thinkingLevel: '', fastMode: false };
  expect(selectModel(current, native).thinkingLevel).toBe('high');
  expect(
    selectModel(current, { ...native, thinkingDefault: 'missing' })
      .thinkingLevel,
  ).toBe('low');
});
it('selects medium for a new model while displaying persisted thinking unchanged until a switch', async () => {
  function Form() {
    const [value, setValue] = useState({
      model: reasoning.id,
      thinkingLevel: 'high',
      fastMode: false,
    });
    return (
      <ModelControls
        models={[reasoning, { ...reasoning, id: 'other' }]}
        value={value}
        onChange={setValue}
      />
    );
  }
  render(<Form />);
  const thinking = screen.getByLabelText('Thinking');
  expect(thinking).toHaveAttribute('data-value', 'high');
  await chooseOption(screen.getByLabelText('Model'), 'other');
  expect(thinking).toHaveAttribute('data-value', 'medium');
  expect(screen.getByText(/Thinking changed to medium/)).toBeVisible();
});
