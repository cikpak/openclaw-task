import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = readFileSync(
  new URL(
    '../apps/frontend/src/conversation/Conversation.module.css',
    import.meta.url,
  ),
  'utf8',
);
const theme = readFileSync(
  new URL('../apps/frontend/src/styles.css', import.meta.url),
  'utf8',
);
const rule = (selector) => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

it('adds pale blue and cyan glows that fade into a contrasting cool canvas', () => {
  const canvas = rule('.conversation');
  expect(canvas.match(/radial-gradient\(/g)).toHaveLength(2);
  expect(canvas).toContain('#d6e7ffcc');
  expect(canvas).toContain('#d6e7ff00 70%');
  expect(canvas).toContain('#d9f2ffb3');
  expect(canvas).toContain('#d9f2ff00 72%');
  expect(canvas).toMatch(/#e8edf4;\s*$/);
  expect(canvas).not.toContain('linear-gradient');
  expect(canvas).not.toMatch(/animation:|url\(|position:|opacity:/);
});

it('keeps distinct opaque assistant, user, header and composer surfaces', () => {
  expect(theme).toContain('--paper: #ffffff;');
  expect(rule('.agentMessage')).toContain('background: var(--paper);');
  expect(rule('.userMessage')).toContain('background: #cbd8ec;');
  expect(rule('.header')).toContain('background: #ffffff;');
  expect(rule('.header')).not.toMatch(
    /opacity:|background:.*(?:rgba|transparent)/,
  );
  expect(rule('.composer')).toContain('background: #fafafa;');
  expect(rule('.message')).toContain('border: 0;');
});
