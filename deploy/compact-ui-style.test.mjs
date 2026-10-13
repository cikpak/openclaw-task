import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path) =>
  readFileSync(
    new URL(`../apps/frontend/src/${path}`, import.meta.url),
    'utf8',
  );
const app = read('App.module.css');
const attachments = read('attachments/Attachments.module.css');
const ui = read('ui/Ui.module.css');
const global = read('styles.css');
const composer = read('conversation/Conversation.module.css');
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'g'))]
    .map((match) => match[1])
    .join('\n');
}

it('defines equal centered desktop login panels and compact form-first mobile stacking', () => {
  expect(rule(app, '.login')).toContain(
    'grid-template-columns: repeat(2, minmax(0, 1fr));',
  );
  expect(app).toMatch(
    /\.loginPanel,\s*\.loginIntro\s*\{[^}]*align-items: center;[^}]*justify-content: center;/,
  );
  expect(rule(app, '.loginIntro')).toContain('linear-gradient');
  expect(rule(app, '.loginIntro')).not.toContain('url(');
  expect(rule(app, '.loginForm')).toContain('width: min(100%, 340px);');
  expect(rule(app, '.loginForm')).not.toContain('border-top');
  expect(rule(app, '.brand')).toContain('color: #000000;');
  const mobile = app.split('@media (max-width: 700px)')[1] ?? '';
  expect(rule(mobile, '.login')).toContain(
    'grid-template-columns: minmax(0, 1fr);',
  );
  expect(mobile).toContain('.loginPanel,');
});

it('centers Home within its available main area while preserving mobile navigation', () => {
  const home = rule(app, '.home');
  expect(home).toContain('min-height: 100%;');
  expect(home).toContain('align-items: center;');
  expect(home).toContain('justify-content: center;');
  expect(home).toContain('text-align: center;');
  expect(app).toMatch(
    /\.shell:not\(\.detailRoute\) \.content\s*\{\s*display: none;/,
  );
});

it('gives Settings a hover and keyboard focus treatment with a larger username', () => {
  expect(app).toMatch(
    /\.preferences:hover,\s*\.preferences:focus-visible\s*\{[^}]*background:/,
  );
  expect(rule(app, '.preferences small')).toContain('font-size: 13px;');
});

it('removes upload focus outlines while retaining pointer cursor and a background cue', () => {
  expect(rule(attachments, '.attach')).toContain('cursor: pointer;');
  expect(rule(attachments, '.attach input')).toContain('cursor: pointer;');
  expect(rule(attachments, '.attach input')).toContain('outline: none;');
  expect(rule(attachments, '.attach input:focus')).toContain('outline: none;');
  expect(rule(attachments, '.attach:focus-within')).toContain('outline: none;');
  expect(rule(attachments, '.attach:focus-within')).toContain(
    'background: #e3e3e3;',
  );
});

it('keeps 16px icon slots and preserves touch targets and aligned compact composer controls', () => {
  expect(rule(ui, '.iconSlot')).toContain('flex: 0 0 16px;');
  expect(rule(ui, '.iconSlot')).toContain('height: 16px;');
  expect(rule(ui, '.select > svg')).toContain('flex: 0 0 16px;');
  expect(rule(attachments, '.item > svg')).toContain('flex: 0 0 16px;');
  // 16px glyph + 20px vertical padding + two border pixels preserves the old 38px generic Button.
  expect(rule(ui, '.button')).toContain('padding-block: 10px;');
  expect(rule(ui, '.button')).not.toContain('min-height:');
  expect(rule(composer, '.composer footer button')).toContain(
    'padding: 5px 10px;',
  );
  expect(rule(composer, '.composer footer > button')).toContain(
    'height: 36px;',
  );
  expect(rule(composer, '.behavior button')).toContain('height: 36px;');
  expect(rule(app, '.newChat')).toContain('min-height: 38px;');
  expect(rule(app, '.home button')).toContain('min-height: 38px;');
  const mobile = app.split('@media (max-width: 700px)')[1] ?? '';
  expect(mobile).toMatch(/\.newChat,\s*\.home button\s*\{\s*min-height: 44px;/);
  expect(global).toMatch(
    /@media \(max-width: 700px\)[\s\S]*button\s*\{[^}]*min-width: 44px;[^}]*min-height: 44px;/,
  );
});

it('animates notifications using shared tokens and keeps reduced-motion behavior', () => {
  expect(rule(app, '.toast')).toContain('pointer-events: auto;');
  expect(rule(app, '.toast')).toContain(
    'animation: toast-enter var(--motion-dialog) var(--ease-out);',
  );
  expect(rule(app, '.toast[data-closing]')).toContain(
    'animation: toast-exit var(--motion-dialog) var(--ease-out) forwards;',
  );
  expect(global).toContain('@media (prefers-reduced-motion: reduce)');
  expect(global).toContain('animation: none !important;');
  expect(global).toContain('transition: none !important;');
});
