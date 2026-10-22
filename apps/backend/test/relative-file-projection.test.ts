import { expect, it } from 'vitest';
import {
  BrowserProjection,
  SafeTextStream,
  type FilePublication,
} from '../src/presentation/safe.js';
const root = '/recovery/agents/a/documents';
const file: FilePublication = {
  nativePath: `${root}/report.txt`,
  relativePath: 'documents/report.txt',
  classification: 'deliverable',
  file: {
    id: 'opaque-a',
    name: 'report.txt',
    mimeType: 'text/plain',
    sizeBytes: 12,
    category: 'deliverable',
    updatedAt: 1,
  },
};
function projection(files = [file], roots = [root]) {
  return new BrowserProjection({ documentsRoots: roots, publications: files });
}
it('rewrites audited relative Markdown references identically at every stream split, including filename spaces', () => {
  for (const name of ['report.txt', 'report with spaces.txt']) {
    const record = {
      ...file,
      nativePath: `${root}/${name}`,
      relativePath: `documents/${name}`,
      file: { ...file.file, name },
    };
    for (const prefix of ['', './']) {
      const input = `Ready [Download](${prefix}documents/${name}) now`;
      const expected = 'Ready [Download](file:opaque-a) now';
      expect(projection([record]).text(input)).toBe(expected);
      for (let split = 0; split <= input.length; split++) {
        const stream = new SafeTextStream(projection([record]));
        expect(
          stream.push(input.slice(0, split)) +
            stream.push(input.slice(split)) +
            stream.finish(),
        ).toBe(expected);
      }
    }
  }
});
it('requires explicit audited aliases and rejects private, unclassified, traversal and forged aliases', () => {
  const global = { ...file, relativePath: undefined };
  expect(projection([global]).text('documents/report.txt')).not.toContain(
    'file:',
  );
  for (const classification of ['private', 'unclassified'] as const)
    expect(
      projection([{ ...file, classification }]).text('documents/report.txt'),
    ).not.toContain('file:');
  for (const path of [
    'documents/private.txt',
    '../documents/report.txt',
    'documents/../report.txt',
    'documents/report.txt.bak',
    'documents/.messenger-inputs/report.txt',
  ])
    expect(projection().text(path)).not.toContain('file:opaque-a');
  expect(
    projection([{ ...file, relativePath: 'documents/other.txt' }]).text(
      'documents/other.txt',
    ),
  ).not.toContain('file:');
});
it('rewrites exact published line citations at every stream split without admitting forged suffixes', () => {
  for (const path of [
    file.nativePath,
    'documents/report.txt',
    './documents/report.txt',
  ]) {
    for (const citation of [':1', ':123:45']) {
      const input = `Saved \`${path}${citation}\` now`;
      const expected = 'Saved `file:opaque-a` now';
      expect(projection().text(input)).toBe(expected);
      for (let split = 0; split <= input.length; split++) {
        const stream = new SafeTextStream(projection());
        expect(
          stream.push(input.slice(0, split)) +
            stream.push(input.slice(split)) +
            stream.finish(),
        ).toBe(expected);
      }
    }
    for (const suffix of [
      ':0',
      ':1:0',
      ':1:evil',
      ':1:2:3',
      ':1/secret',
      ':1.bak',
    ])
      expect(projection().text(`${path}${suffix}`)).not.toContain(
        'file:opaque-a',
      );
  }
  for (const classification of ['private', 'unclassified'] as const)
    expect(
      projection([{ ...file, classification }]).text('documents/report.txt:1'),
    ).not.toContain('file:');
  expect(projection().text('documents/private.txt:1')).not.toContain('file:');
});
it('does not rewrite public URLs or choose an ambiguous same-name relative reference', () => {
  for (const url of [
    'https://example.test/documents/report.txt',
    `https://example.test${file.nativePath}`,
  ])
    expect(projection().text(`[Public](${url})`)).toBe(`[Public](${url})`);
  const otherRoot = '/recovery/agents/b/documents';
  const other = {
    ...file,
    nativePath: `${otherRoot}/report.txt`,
    file: { ...file.file, id: 'opaque-b' },
  };
  expect(
    projection([file, other], [root, otherRoot]).text('documents/report.txt'),
  ).not.toContain('file:');
  expect(projection().text(file.nativePath)).toBe('file:opaque-a');
});
