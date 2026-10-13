import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = readFileSync(
  new URL('../apps/frontend/src/ui/Ui.module.css', import.meta.url),
  'utf8',
);
it('keeps every status dot the same size and animates only the blue working state', () => {
  expect(css).toMatch(
    /\.chatStatusDot\s*\{[^}]*width: 8px;[^}]*height: 8px;[^}]*flex: 0 0 8px;/,
  );
  expect(css).toMatch(
    /data-chat-state='working'\]\s*\{[^}]*linear-gradient[^}]*animation: chat-status-shimmer/,
  );
  expect(css).toContain('@keyframes chat-status-shimmer');
});
it('uses green for answers, red for failures, amber for recovery and a static reduced-motion state', () => {
  expect(css).toMatch(
    /data-chat-state='answered'\]\s*\{[^}]*background: #15803d;/,
  );
  expect(css).toMatch(
    /data-chat-state='failed'\]\s*\{[^}]*background: #dc2626;/,
  );
  expect(css).toMatch(
    /data-chat-state='attention'\]\s*\{[^}]*background: #ca8a04;/,
  );
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*data-chat-state='working'\]\s*\{[^}]*animation: none;[^}]*background: #2563eb;/,
  );
});
