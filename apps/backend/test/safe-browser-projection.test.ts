import { describe, expect, it } from 'vitest';
import {
  BrowserProjection,
  SafeTextStream,
  type FilePublication,
} from '../src/presentation/safe.js';

const root = '/recovery/agents/example/documents';
const publication: FilePublication = {
  nativePath: `${root}/report.txt`,
  classification: 'deliverable',
  file: {
    id: 'opaque-123',
    name: 'report.txt',
    mimeType: 'text/plain',
    sizeBytes: 5,
    category: 'deliverable',
    updatedAt: 1,
  },
};
function projector(publications = [publication]) {
  return new BrowserProjection({
    documentsRoots: [root],
    publications,
    secrets: ['gateway-private-secret'],
  });
}
describe('browser-safe projection', () => {
  it('projects paths and secrets split at every possible stream boundary', () => {
    const text = `Here ${publication.nativePath} and /recovery/private/openclaw.json gateway-private-secret done`;
    for (let split = 0; split <= text.length; split++) {
      const stream = new SafeTextStream(projector());
      const result =
        stream.push(text.slice(0, split)) +
        stream.push(text.slice(split)) +
        stream.finish();
      expect(result).toBe(
        'Here file:opaque-123 and [private reference] [redacted] done',
      );
    }
  });
  it('holds a native prefix until its token is safe to publish', () => {
    const stream = new SafeTextStream(projector());
    expect(stream.push('Ready /rec')).toBe('Ready ');
    expect(stream.push('overy/private')).toBe('');
    expect(stream.finish()).toBe('[private reference]');
  });
  it('does not grant publication based only on documents placement', () => {
    for (const classification of ['private', 'unclassified'] as const) {
      const projection = projector([{ ...publication, classification }]);
      expect(projection.file(publication.nativePath)).toBeNull();
      expect(projection.text(publication.nativePath)).toBe(
        '[private reference]',
      );
    }
    expect(
      projector([{ ...publication, nativePath: `${root}/SOUL.md` }]).file(
        `${root}/SOUL.md`,
      ),
    ).toBeNull();
    expect(
      projector([{ ...publication, nativePath: `${root}/../secret` }]).file(
        `${root}/../secret`,
      ),
    ).toBeNull();
  });
  it('suppresses internal tools and uses only verified operation counts', () => {
    const projection = projector();
    expect(
      projection.tool({
        id: 'tool',
        operation: 'write',
        status: 'completed',
        nativePath: '/recovery/AGENTS.md',
      }),
    ).toBeNull();
    expect(
      projection.tool({
        id: 'tool',
        operation: 'fetch',
        status: 'completed',
        nativePath: '/recovery/AGENTS.md',
      }),
    ).toBeNull();
    expect(
      projection.tool({
        id: '/recovery/secret',
        operation: 'fetch',
        status: 'completed',
      }),
    ).toBeNull();
    expect(
      projection.tool({
        id: 'tool',
        operation: 'write',
        status: 'completed',
        nativePath: publication.nativePath,
        verifiedLineCount: 12,
      }),
    ).toEqual({
      id: 'tool',
      operation: 'write',
      status: 'completed',
      text: 'Wrote 12 lines to report.txt',
      fileId: publication.file.id,
    });
    expect(
      projection.tool({
        id: 'tool',
        operation: 'write',
        status: 'completed',
        nativePath: publication.nativePath,
      })?.text,
    ).toBe('Wrote report.txt');
  });
  it('bounds unfinished scratch tokens and resumes after suppression', () => {
    const stream = new SafeTextStream(projector(), 20);
    expect(stream.push('/recovery/' + 'x'.repeat(100000))).toBe('');
    expect(stream.push(' complete') + stream.finish()).toBe(
      '[private reference] complete',
    );
  });
  it('keeps normal web URLs and never returns native metadata fields', () => {
    expect(
      projector().text(
        'See https://example.com/article and C:\\private\\secret',
      ),
    ).toBe('See https://example.com/article and [private reference]');
    expect(projector().file(publication.nativePath)).not.toHaveProperty(
      'nativePath',
    );
  });
  it('does not authorize a known path prefix or unsafe metadata basename', () => {
    expect(projector().text(`${publication.nativePath}.private`)).toBe(
      '[private reference]',
    );
    expect(projector().text(`<${publication.nativePath}.private>`)).toBe(
      '<[private reference]>',
    );
    const projection = projector([
      {
        ...publication,
        file: { ...publication.file, name: '/recovery/secret' },
      },
    ]);
    expect(projection.file(publication.nativePath)).toBeNull();
  });
  it('redacts secrets containing whitespace at every streaming boundary', () => {
    const projection = new BrowserProjection({
      documentsRoots: [],
      publications: [],
      secrets: ['private key\nwith spaces'],
    });
    const text = 'Before private key\nwith spaces after';
    for (let split = 0; split <= text.length; split++) {
      const stream = new SafeTextStream(projection);
      expect(
        stream.push(text.slice(0, split)) +
          stream.push(text.slice(split)) +
          stream.finish(),
      ).toBe('Before [redacted] after');
    }
  });
});

it('keeps completed ordinary content beyond the streaming scratch bound', () => {
  const text = 'long ' + 'x'.repeat(12000) + ' completed';
  expect(projector().text(text)).toBe(text);
});

it('suppresses relative internal and inline-code native references at all chunk splits', () => {
  for (const reference of [
    '.openclaw/config.json',
    './private/config',
    '../private/config',
    'openclaw.json',
    '`/recovery/private/config`',
  ]) {
    const input = `Before ${reference} after`;
    for (let split = 0; split <= input.length; split++) {
      const stream = new SafeTextStream(projector());
      const result =
        stream.push(input.slice(0, split)) +
        stream.push(input.slice(split)) +
        stream.finish();
      expect(result).not.toContain(reference.replaceAll('`', ''));
      expect(result).toContain('[private reference]');
    }
  }
});

it('converts classified paths containing spaces across every stream boundary', () => {
  const file = {
    ...publication,
    nativePath: `${root}/Quarterly Report.txt`,
    file: { ...publication.file, name: 'Quarterly Report.txt' },
  };
  const projection = projector([file]);
  for (const wrapper of ['', 'file://', '`', '<']) {
    const input = `Before ${wrapper}${file.nativePath} after`;
    for (let split = 0; split <= input.length; split++) {
      const stream = new SafeTextStream(projection);
      const result =
        stream.push(input.slice(0, split)) +
        stream.push(input.slice(split)) +
        stream.finish();
      expect(result).toBe(
        `Before ${wrapper === 'file://' ? '' : wrapper}file:opaque-123 after`,
      );
    }
  }
});
