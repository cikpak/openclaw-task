import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = readFileSync(
  new URL(
    '../apps/frontend/src/attachments/Attachments.module.css',
    import.meta.url,
  ),
  'utf8',
);

it('centers download icons in a fixed slot instead of an inline text line box', () => {
  expect(css).toMatch(
    /\.fileDownload\s*\{[^}]*display: inline-flex;[^}]*align-items: center;[^}]*gap: 6px;/,
  );
  expect(css).toMatch(
    /\.fileDownload > span\[aria-hidden='true'\]\s*\{[^}]*display: inline-flex;[^}]*align-items: center;[^}]*justify-content: center;[^}]*flex: 0 0 16px;[^}]*height: 16px;[^}]*line-height: 1;/,
  );
  expect(css).toMatch(
    /\.fileDownload > span\[aria-hidden='true'\] > svg\s*\{\s*display: block;/,
  );
});

it('preserves the same slot during downloads and keeps mobile touch targets', () => {
  const component = readFileSync(
    new URL(
      '../apps/frontend/src/attachments/AgentFileLink.tsx',
      import.meta.url,
    ),
    'utf8',
  );
  expect(component).toContain(
    'className={card ? styles.fileCard : styles.fileDownload}',
  );
  expect(component).toContain("card ? styles.fileCardIcon : ''");
  expect(component).toContain("busy ? styles.fileDownloadSpinner : ''");
  expect(component).toContain("name={busy ? 'spinner' : 'download'}");
  expect(css).toMatch(
    /@media \(max-width: 700px\)\s*\{\s*\.fileDownload\s*\{\s*min-height: 44px;/,
  );
});
