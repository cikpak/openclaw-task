import { expect, it } from 'vitest';
import { NativeAttachments } from './attachments.js';
import type { GatewayHistory } from '../../../../backend/src/gateway/types.js';
const mapping = { agentId: 'a', sessionKey: 'agent:a:main' };
it('persists exact private appendix across retries/recreation and strips only generated user suffix', async () => {
  const rows = new Map<string, unknown>();
  const storage = {
    get: <T>(key: string) => Promise.resolve(rows.get(key) as T | undefined),
    put: <T>(key: string, value: T) => {
      rows.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(rows.delete(key)),
  };
  const attachment = {
    type: 'file' as const,
    fileName: 'a.txt',
    mimeType: 'text/plain',
    sizeBytes: 4,
    origin: 'file' as const,
    content: '',
    nativePath: '/recovery/a/documents/.messenger-inputs/session/id/a.txt',
  };
  const first = await new NativeAttachments(storage).prepare(
    mapping,
    'id',
    'User text',
    [attachment],
  );
  expect(first.attachments).toEqual([]);
  expect(
    (
      await new NativeAttachments(storage).prepare(mapping, 'id', 'User text', [
        attachment,
      ])
    ).text,
  ).toBe(first.text);
  const history = {
    messages: [
      { id: 'u', role: 'user', text: first.text },
      { id: 'a', role: 'assistant', text: first.text },
      {
        id: 'u2',
        role: 'user',
        text: 'Ordinary [messenger-attachments:guess]',
      },
    ],
  } as GatewayHistory;
  const safe = await new NativeAttachments(storage).history(mapping, history);
  expect(safe.messages.map((message) => message.text)).toEqual([
    'User text',
    first.text,
    'Ordinary [messenger-attachments:guess]',
  ]);
});
