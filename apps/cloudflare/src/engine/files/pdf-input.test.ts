import { expect, it } from 'vitest';
import { NativeAttachments } from './attachments.js';
import { BrowserBoundary } from '../../files/boundary.js';
import {
  BrowserProjection,
  SafeTextStream,
} from '../../../../backend/src/presentation/safe.js';
import type {
  GatewayAttachment,
  GatewayHistory,
} from '../../../../backend/src/gateway/types.js';
const mapping = { agentId: 'a', sessionKey: 'agent:a:main' };
const directory = '/recovery/a/documents/.messenger-inputs/session/id';
const textPath = `${directory}/.pdf-read-${'a'.repeat(64)}/extracted-text.txt`;
const file: GatewayAttachment = {
  type: 'file',
  fileName: 'Original.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 5_000_000,
  origin: 'file',
  content: '',
  nativePath: `${directory}/Original.pdf`,
  nativeReadFiles: [
    { path: textPath, name: 'extracted-text.txt', mimeType: 'text/plain' },
  ],
};
function storage() {
  const rows = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Promise.resolve(rows.get(key) as T | undefined),
    put: <T>(key: string, value: T) => {
      rows.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(rows.delete(key)),
  };
}
it('keeps derived PDF reads private and strips their complete persisted appendix from public history', async () => {
  const values = storage();
  const prepared = await new NativeAttachments(values).prepare(
    mapping,
    'send',
    'Read the attachment',
    [file],
  );
  expect(prepared.attachments).toEqual([]);
  expect(prepared.text.length).toBeLessThan(3000);
  const line = prepared.text.split('\n').find((line) => line.startsWith('{'))!;
  expect(JSON.parse(line)).toEqual({
    name: 'Original.pdf (document text)',
    mimeType: 'text/plain',
    path: textPath,
  });
  const history = await new NativeAttachments(values).history(mapping, {
    messages: [{ id: 'u', role: 'user', text: prepared.text, runId: 'send' }],
  } as GatewayHistory);
  expect(history.messages[0]!.text).toBe('Read the attachment');
  const projection = new BrowserProjection({
    documentsRoots: ['/recovery/a/documents'],
    publications: [],
  });
  expect(projection.file(textPath)).toBeNull();
  expect(
    projection.tool({
      id: 'read',
      operation: 'read',
      status: 'completed',
      nativePath: textPath,
    }),
  ).toBeNull();
  for (const reference of [
    textPath,
    textPath.slice(directory.length + 1),
    `.pdf-read-${'a'.repeat(64)}`,
    `\u0060.pdf-read-${'a'.repeat(64)}\u0060`,
    `'\u002epdf-read-${'a'.repeat(64)}'`,
    'documents/.messenger-inputs/session/id/extracted-text.txt',
  ]) {
    const boundary = new BrowserBoundary(() => ({
      documentsRoots: ['/recovery/a/documents'],
      publications: [],
    }));
    const publicData = JSON.stringify(
      boundary.project({
        message: `Read ${reference}`,
        error: reference,
        tool: reference,
      }),
    );
    expect(publicData).not.toContain('.pdf-read-');
    expect(publicData).not.toContain('.messenger-inputs/');
    expect(publicData).not.toContain('extracted-text.txt');
    const stream = new SafeTextStream(projection);
    const split = Math.floor(reference.length / 2);
    const streamed =
      stream.push(reference.slice(0, split)) +
      stream.push(reference.slice(split) + ' ') +
      stream.finish();
    expect(streamed).not.toContain('extracted-text.txt');
  }
  expect(projection.text('The user uploaded page-1.png')).toBe(
    'The user uploaded page-1.png',
  );
});
it('rejects derived paths that escape the exact private upload directory', async () => {
  const attachments = new NativeAttachments(storage());
  for (const path of [
    textPath + '/../secret.txt',
    `${directory}/.pdf-read-${'a'.repeat(64)}/../../secret.txt`,
    '/recovery/other/documents/private.txt',
  ])
    await expect(
      attachments.prepare(mapping, 'send', 'text', [
        {
          ...file,
          nativeReadFiles: [
            { path, name: 'extracted-text.txt', mimeType: 'text/plain' },
          ],
        },
      ]),
    ).rejects.toThrow('Invalid private attachment');
});
