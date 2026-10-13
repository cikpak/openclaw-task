import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = readFileSync(
  new URL(
    '../apps/frontend/src/conversation/Conversation.module.css',
    import.meta.url,
  ),
  'utf8',
);
const page = readFileSync(
  new URL(
    '../apps/frontend/src/conversation/ConversationPage.tsx',
    import.meta.url,
  ),
  'utf8',
);

it('shares one column width and responsive inline gutter between history and composer', () => {
  expect(css).toContain('--chat-column-width: 960px;');
  expect(css).toContain('--chat-inline-gutter: 32px;');
  expect(css).toContain('max-width: var(--chat-column-width);');
  expect(css).toContain(
    'max-width: calc(var(--chat-column-width) + 2 * var(--chat-inline-gutter));',
  );
  expect(css).toContain('padding: 24px var(--chat-inline-gutter);');
  expect(css).toContain('padding: 8px var(--chat-inline-gutter) 12px;');
  expect(css).toMatch(
    /@media \(max-width: 700px\)[\s\S]*\.chatBody\s*\{\s*--chat-inline-gutter: 14px;/,
  );
});

it('reserves native scrollbar space for the composer without hiding scrollbars or changing message widths', () => {
  expect(css).toContain('scrollbar-gutter: stable;');
  expect(css).toContain(
    'padding-inline-end: var(--chat-scrollbar-gutter, 0px);',
  );
  expect(css).not.toContain('scrollbar-width: none');
  expect(css).toContain('max-width: 85%;');
  expect(page).toContain('useHistoryGutter(history, chatBody);');
  expect(page).toContain('className={styles.chatBody} ref={chatBody}');
  expect(page).toMatch(/className=\{styles.composerViewport\}>\s*<Composer/);
});

it('models matching left/right edges on wide and narrow screens with classic or overlay scrollbars', () => {
  for (const width of [1600, 1200, 980, 700, 360]) {
    for (const scrollbar of [0, 15, 17]) {
      const padding = width <= 700 ? 14 : 32;
      const available = width - scrollbar;
      const historyWidth = Math.min(960, available - 2 * padding);
      const historyLeft = (available - historyWidth) / 2;
      const composerFrame = Math.min(960 + 2 * padding, available);
      const composerLeft = (available - composerFrame) / 2 + padding;
      const composerWidth = composerFrame - 2 * padding;
      expect(composerLeft).toBe(historyLeft);
      expect(composerLeft + composerWidth).toBe(historyLeft + historyWidth);
    }
  }
});
