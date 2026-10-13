import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Select } from './Select';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Unavailable', disabled: true },
];
it('renders official Heroicons outline glyphs at 16px consistently, including the spinner', () => {
  const names: IconName[] = [
    'arrowRight',
    'arrowUp',
    'arrowLeft',
    'arrowUpRight',
    'plus',
    'close',
    'chevronDown',
    'check',
    'refresh',
    'stop',
    'file',
    'download',
    'paperclip',
    'tool',
    'settings',
    'spinner',
  ];
  const { container } = render(
    <>
      {names.map((name) => (
        <Icon key={name} name={name} />
      ))}
    </>,
  );
  const glyphs = container.querySelectorAll('svg');
  expect(glyphs).toHaveLength(names.length);
  for (const glyph of glyphs) {
    expect(glyph).toHaveAttribute('data-slot', 'icon');
    expect(glyph).toHaveAttribute('width', '16');
    expect(glyph).toHaveAttribute('height', '16');
    expect(glyph).toHaveAttribute('viewBox', '0 0 24 24');
    expect(glyph).toHaveAttribute('fill', 'none');
    expect(glyph).toHaveAttribute('stroke-width', '1.5');
    expect(glyph).toHaveAttribute('stroke', 'currentColor');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph).toHaveAttribute('focusable', 'false');
    expect(glyph).toHaveStyle({
      width: '16px',
      height: '16px',
      flexShrink: '0',
    });
  }
  expect(glyphs[names.indexOf('spinner')]?.innerHTML).toEqual(
    glyphs[names.indexOf('refresh')]?.innerHTML,
  );
});
function Form() {
  const [value, setValue] = useState('a');
  return (
    <Select
      label="Choice"
      value={value}
      onChange={setValue}
      options={options}
    />
  );
}
it('opens with pointer and selects a choice', async () => {
  render(<Form />);
  fireEvent.click(screen.getByRole('combobox'));
  await act(async () => {});
  expect(screen.getByRole('listbox')).toHaveStyle({ position: 'fixed' });
  expect(
    screen.getByRole('listbox').closest('[data-floating-ui-portal]'),
  ).not.toBeNull();
  expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('combobox')).toHaveAttribute(
    'aria-controls',
    screen.getByRole('listbox').id,
  );
  expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await userEvent.click(screen.getByRole('option', { name: 'Beta' }));
  expect(screen.getByRole('combobox')).toHaveAttribute('data-value', 'b');
});
it('retains a fixed icon and label while a button is busy', async () => {
  const action = vi.fn();
  const { rerender } = render(
    <Button onClick={action} icon="check">
      Save
    </Button>,
  );
  const slot = screen.getByRole('button').firstElementChild;
  rerender(
    <Button busy onClick={action} icon="check">
      Save
    </Button>,
  );
  expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  expect(screen.getByRole('button').firstElementChild).toBe(slot);
  expect(screen.getByRole('button').querySelector('svg')).toHaveAttribute(
    'width',
    '16',
  );
  await userEvent.click(screen.getByRole('button'));
  expect(action).not.toHaveBeenCalled();
});
it('supports keyboard navigation, typeahead, selection and Escape focus return', async () => {
  render(<Form />);
  const control = screen.getByRole('combobox');
  control.focus();
  await userEvent.keyboard('{ArrowDown}');
  await act(async () => {});
  await userEvent.keyboard('b');
  await waitFor(() =>
    expect(screen.getByRole('option', { name: 'Beta' })).toHaveFocus(),
  );
  await userEvent.keyboard('{Enter}');
  expect(control).toHaveAttribute('data-value', 'b');
  expect(control).toHaveFocus();
  await userEvent.click(control);
  await userEvent.keyboard('{Escape}');
  expect(control).toHaveAttribute('aria-expanded', 'false');
  await waitFor(() =>
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument(),
  );
  expect(control).toHaveFocus();
});
it('does not choose disabled options and does not reopen a stale menu when re-enabled', async () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <Select label="Choice" value="a" options={options} onChange={onChange} />,
  );
  const control = screen.getByRole('combobox');
  await userEvent.click(control);
  await act(async () => {});
  const unavailable = screen.getByRole('option', { name: 'Unavailable' });
  expect(unavailable).toBeDisabled();
  await userEvent.click(unavailable);
  expect(onChange).not.toHaveBeenCalled();
  rerender(
    <Select
      disabled
      label="Choice"
      value="a"
      options={options}
      onChange={onChange}
    />,
  );
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  rerender(
    <Select label="Choice" value="a" options={options} onChange={onChange} />,
  );
  await waitFor(() =>
    expect(control).toHaveAttribute('aria-expanded', 'false'),
  );
  await waitFor(() =>
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument(),
  );
});
it('accepts immediately after reopening with reduced motion even before option focus settles', async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true })),
  );
  render(<Form />);
  const control = screen.getByRole('combobox');
  await userEvent.click(control);
  await userEvent.keyboard('{Escape}');
  await waitFor(() =>
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument(),
  );
  expect(control).toHaveFocus();
  await userEvent.keyboard('{ArrowDown}');
  await userEvent.keyboard('{Enter}');
  await waitFor(() =>
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument(),
  );
  expect(control).toHaveAttribute('data-value', 'a');
  expect(control).toHaveFocus();
});
it.each([false, true])(
  'accepts rapid Home/End selection with delayed navigation focus (reduced motion: %s)',
  async (reducedMotion) => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: reducedMotion })),
    );
    render(<Form />);
    const control = screen.getByRole('combobox');
    await userEvent.click(control);
    await userEvent.click(screen.getByRole('option', { name: 'Beta' }));
    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument(),
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    await userEvent.keyboard('{ArrowDown}{Home}{Enter}');
    await waitFor(() => expect(control).toHaveAttribute('data-value', 'a'));
    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument(),
    );
    expect(control).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{End}{Enter}');
    await waitFor(() => expect(control).toHaveAttribute('data-value', 'b'));
    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument(),
    );
    expect(control).toHaveFocus();
  },
);
