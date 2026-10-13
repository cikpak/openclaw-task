import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = readFileSync(
  new URL(
    '../apps/frontend/src/conversation/Conversation.module.css',
    import.meta.url,
  ),
  'utf8',
);

it('centers the history button with an aligned icon/text row and a stable gap', () => {
  expect(css).toMatch(
    /\.history \.older\s*\{[^}]*display: flex;[^}]*align-items: center;[^}]*justify-content: center;[^}]*gap: 8px;[^}]*width: fit-content;[^}]*margin: 0 auto 24px;/,
  );
  expect(css).toMatch(/\.history \.older svg\s*\{\s*display: block;/);
  expect(css).not.toMatch(/\.older\s*\{\s*display: block;/);
});
