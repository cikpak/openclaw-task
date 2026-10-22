import { expect, it } from 'vitest';
import { NativeAttachments } from './attachments.js';
import type { Attachment } from '@messenger/contracts';
import type {
  GatewayAttachment,
  GatewayHistory,
} from '../../../../backend/src/gateway/types.js';
const mapping = { agentId: 'agent-a', sessionKey: 'agent:agent-a:main' };
const metadata: Attachment = {
  uploadId: 'original-upload',
  name: 'Original.txt',
  mimeType: 'text/plain',
  size: 17,
};
const file: GatewayAttachment = {
  type: 'file',
  fileName: metadata.name,
  mimeType: metadata.mimeType,
  sizeBytes: metadata.size,
  origin: 'file',
  content: '',
  nativePath:
    '/recovery/agent-a/documents/.messenger-inputs/session/upload/Original.txt',
  originalAttachment: Object.assign({}, metadata, { nativePath: 'never-copy' }),
};
function store() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: <T>(key: string) => Promise.resolve(rows.get(key) as T | undefined),
    put: <T>(key: string, value: T) => {
      rows.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(rows.delete(key)),
  };
}
const history = (text: string, runId?: string, role = 'user') =>
  ({ messages: [{ id: 'message', role, text, runId }] }) as GatewayHistory;
it('restores only the authoritative original public metadata after recreation and idempotent retry', async () => {
  const storage = store();
  const prepared = await new NativeAttachments(storage).prepare(
    mapping,
    'submission',
    'Read this',
    [file],
  );
  expect(prepared.attachments).toEqual([]);
  await new NativeAttachments(storage).prepare(
    mapping,
    'submission',
    'Read this',
    [{ ...file, originalAttachment: { ...metadata, uploadId: 'replacement' } }],
  );
  const result = await new NativeAttachments(storage).history(
    mapping,
    history(prepared.text, 'submission'),
  );
  expect(result.messages[0]).toMatchObject({
    text: 'Read this',
    attachments: [metadata],
  });
  expect(Object.keys(result.messages[0]!.attachments![0]!).sort()).toEqual(
    ['uploadId', 'name', 'mimeType', 'size'].sort(),
  );
  expect(JSON.stringify(result)).not.toContain('nativePath');
  expect(JSON.stringify(result)).not.toContain('.messenger-inputs');
  expect(JSON.stringify(result)).not.toContain('never-copy');
  const stored = storage.rows.get(
    `attachment-appendix:${mapping.sessionKey}:submission`,
  ) as { attachments: Attachment[] };
  expect(stored.attachments).toEqual([metadata]);
});
it('requires the exact user appendix, session and submission before restoring attachment metadata', async () => {
  const storage = store();
  const attachments = new NativeAttachments(storage);
  const prepared = await attachments.prepare(
    mapping,
    'submission',
    'Read this',
    [file],
  );
  for (const input of [
    history(prepared.text, 'different-submission'),
    history(prepared.text, 'submission', 'assistant'),
    history(prepared.text + ' changed', 'submission'),
    history(
      prepared.text.replace(
        /attachments:[a-f0-9-]{36}/,
        `attachments:${crypto.randomUUID()}`,
      ),
      'submission',
    ),
  ]) {
    const result = await attachments.history(mapping, input);
    expect(result).toEqual(input);
    expect(result.messages[0]!.attachments).toBeUndefined();
  }
  const foreign = await attachments.history(
    { ...mapping, sessionKey: 'agent:other:main' },
    history(prepared.text, 'submission'),
  );
  expect(foreign.messages[0]!.attachments).toBeUndefined();
  expect(foreign.messages[0]!.text).toBe(prepared.text);
});
