import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Icon, type IconName } from './Icon';

const names: IconName[] = [
  'file',
  'write',
  'edit',
  'globe',
  'search',
  'terminal',
  'image',
];

it('keeps every tool glyph in the same compact outline style', () => {
  const { container } = render(
    <>
      {names.map((name) => (
        <Icon key={name} name={name} />
      ))}
    </>,
  );
  const icons = container.querySelectorAll('svg');
  expect(icons).toHaveLength(names.length);
  for (const icon of icons) {
    expect(icon).toHaveAttribute('width', '16');
    expect(icon).toHaveAttribute('height', '16');
    expect(icon).toHaveAttribute('viewBox', '0 0 24 24');
    expect(icon).toHaveAttribute('fill', 'none');
    expect(icon).toHaveAttribute('stroke-width', '1.5');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  }
});

it('distinguishes read, write, edit, web, search, command and image actions', () => {
  const { container } = render(
    <>
      {names.map((name) => (
        <Icon key={name} name={name} />
      ))}
    </>,
  );
  expect(
    new Set(
      [...container.querySelectorAll('svg')].map((icon) => icon.innerHTML),
    ).size,
  ).toBe(names.length);
});
