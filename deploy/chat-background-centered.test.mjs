import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = readFileSync(
  new URL(
    '../apps/frontend/src/conversation/Conversation.module.css',
    import.meta.url,
  ),
  'utf8',
);
const rule = (selector) => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};
const canvas = rule('.conversation');

it('centers both glows vertically instead of clipping them at the top edge', () => {
  expect(canvas).toContain('ellipse 56% 44% at 44% 50%');
  expect(canvas).toContain('ellipse 42% 38% at 61% 50%');
});

it('keeps the gradient on the existing canvas without overlays, motion or layout changes', () => {
  expect(canvas).toContain('height: 100%;');
  expect(canvas).toContain('display: flex;');
  expect(canvas).toContain('flex-direction: column;');
  expect(canvas).not.toMatch(/animation:|position:|padding:|margin:|opacity:/);
  expect(css).not.toMatch(/\.conversation::?(?:before|after)/);
  expect(rule('.history')).toContain('overflow: auto;');
  expect(rule('.history')).toContain('scrollbar-gutter: stable;');
  expect(rule('.historyInner')).toContain(
    'max-width: var(--chat-column-width);',
  );
  expect(rule('.composerWrap')).toContain(
    'max-width: calc(var(--chat-column-width) + 2 * var(--chat-inline-gutter));',
  );
  expect(rule('.message')).toContain('max-width: 85%;');
});
