import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { models } from '../test/fixtures';
import { ModelControls } from './ModelControls';

it.each(['unknown', 'unsupported'] as const)(
  'explains %s Fast capability without enabling it',
  (fastModeSupport) => {
    const base = models[1];
    if (!base) throw new Error('Missing fixture model');
    render(
      <ModelControls
        models={[{ ...base, fastModeSupport }]}
        value={{ model: base.id, thinkingLevel: 'off', fastMode: false }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Speed' })).toBeDisabled();
    expect(
      screen.getByText(
        fastModeSupport === 'unknown'
          ? /Gateway has not reported Fast support/
          : /Fast is unsupported/,
      ),
    ).toBeVisible();
  },
);

it.each([
  ['unknown', 'Fast · support unconfirmed'],
  ['unsupported', 'Fast · no longer supported'],
  [undefined, 'Fast · support unconfirmed'],
] as const)(
  'retains saved Fast with %s support without claiming unreported support is unsupported',
  async (fastModeSupport, label) => {
    const base = models[1];
    if (!base) throw new Error('Missing fixture model');
    const model =
      fastModeSupport === undefined ? base : { ...base, fastModeSupport };
    const onChange = vi.fn();
    render(
      <ModelControls
        models={[model]}
        value={{ model: base.id, thinkingLevel: 'off', fastMode: true }}
        onChange={onChange}
      />,
    );
    const speed = screen.getByRole('combobox', { name: 'Speed' });
    expect(speed).toHaveTextContent(label);
    expect(speed).toHaveAttribute('data-value', 'fast');
    expect(speed).toBeDisabled();
    expect(
      screen.getByText(
        fastModeSupport === 'unsupported'
          ? /Fast is unsupported/
          : /Gateway has not reported Fast support/,
      ),
    ).toBeVisible();
    await userEvent.click(speed);
    expect(screen.queryByRole('listbox', { name: 'Speed options' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  },
);

it('retains confirmed Fast without an unconfirmed or unsupported label', () => {
  const base = models[0];
  if (!base) throw new Error('Missing fixture model');
  render(
    <ModelControls
      models={[{ ...base, fastModeSupport: 'supported' }]}
      value={{ model: base.id, thinkingLevel: 'high', fastMode: true }}
      onChange={vi.fn()}
    />,
  );
  const speed = screen.getByRole('combobox', { name: 'Speed' });
  expect(speed).toHaveTextContent(/^Fast$/);
  expect(speed).toHaveAttribute('data-value', 'fast');
  expect(speed).toBeEnabled();
});
