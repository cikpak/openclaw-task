import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const attachments = readFileSync(
  new URL(
    '../apps/frontend/src/attachments/Attachments.module.css',
    import.meta.url,
  ),
  'utf8',
);
const conversation = readFileSync(
  new URL(
    '../apps/frontend/src/conversation/Conversation.module.css',
    import.meta.url,
  ),
  'utf8',
);
const declarations = (selector) => {
  const start = attachments.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return attachments.slice(start, attachments.indexOf('}', start));
};

it('separates selected chips from upload without adding space to empty pickers or shared files', () => {
  expect(declarations('.picker')).toContain('margin: 0;');
  expect(declarations('.picker > .items:not(:empty)')).toContain(
    'margin-bottom: 8px;',
  );
  expect(declarations('.items')).not.toContain('margin-bottom');
});

it('centers the upload focus hitbox and bounds its transparent file input', () => {
  const attach = declarations('.attach');
  expect(attach).toContain('flex-direction: row;');
  expect(attach).toContain('align-items: center;');
  expect(attach).toContain('justify-content: center;');
  expect(attach).toContain('min-height: 36px;');
  expect(attach).toContain('padding: 4px 6px;');
  expect(attach).toContain('margin-inline: -6px;');
  const input = declarations('.attach input');
  expect(input).toContain('height: 100%;');
  expect(input).toContain('min-height: 0;');
  expect(input).toContain('padding: 0;');
  expect(input).toContain('border: 0;');
  expect(declarations('.attach:focus-within')).toContain('background:');
  expect(attachments).toMatch(
    /@media \(max-width: 700px\)[\s\S]*\.attach,[\s\S]*min-height: 44px;/,
  );
});

it('highlights the composer only for text input, not upload focus', () => {
  expect(conversation).not.toContain('.composer:focus-within');
  expect(conversation).toMatch(
    /\.composer:has\(textarea:focus\)\s*\{[^}]*border-color:[^}]*box-shadow:/,
  );
});
