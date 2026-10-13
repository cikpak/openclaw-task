import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const settings = readFileSync(
  new URL('../apps/frontend/src/settings/Settings.module.css', import.meta.url),
  'utf8',
);

it('prevents the keep button from stretching around a top-margined destructive action', () => {
  expect(settings).toMatch(
    /\.actions:has\(> \.danger\)\s*\{\s*align-items: center;\s*\}/,
  );
  expect(settings).toMatch(/\.actions > \.danger\s*\{\s*margin-top: 0;\s*\}/);
  // The standalone Delete conversation action keeps its existing section spacing.
  expect(settings).toMatch(/\.danger\s*\{[^}]*margin-top: 16px;/);
});

it('keeps normal button sizing and mobile touch targets instead of forcing a smaller height', () => {
  const global = readFileSync(
    new URL('../apps/frontend/src/styles.css', import.meta.url),
    'utf8',
  );
  expect(global).toMatch(/button\s*\{[^}]*min-height: 34px;/);
  expect(global).toMatch(
    /@media \(max-width: 700px\)[\s\S]*button\s*\{[^}]*min-height: 44px;/,
  );
  expect(settings).not.toMatch(/\.actions[^}]*\{[^}]*height:/);
});
