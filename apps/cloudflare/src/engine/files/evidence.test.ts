import { expect, it, vi } from 'vitest';
import { EngineFiles } from './service.js';
import type { AuthStorage } from '../gateway/identity.js';
it('publishes an explicitly successful write after manager recreation and removes terminal evidence', async () => {
  const rows = new Map<string, unknown>();
  const storage: AuthStorage = {
    get: <T>(key: string) => Promise.resolve(rows.get(key) as T | undefined),
    put: <T>(key: string, value: T) => {
      rows.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(rows.delete(key)),
  };
  const mapping = { agentId: 'agent', sessionKey: 'agent:agent:main' };
  const metadata = {
    path: '/recovery/agent/documents/report.txt',
    documentsRoot: '/recovery/agent/documents',
    name: 'report.txt',
    mimeType: 'text/plain',
    size: 4,
    modifiedAt: 1,
    digest: 'a'.repeat(64),
  };
  const file = {
    id: 'opaque-random',
    name: metadata.name,
    mimeType: metadata.mimeType,
    sizeBytes: 4,
    updatedAt: 1,
    category: 'deliverable' as const,
  };
  const publish = vi.fn(() => Promise.resolve(file));
  const options = {
    storage,
    helper: () => Promise.resolve(Response.json(metadata)),
    mapping: () => mapping,
    catalog: {
      publish,
      revoke: () => Promise.resolve(),
      records: () => [],
      policy: () => ({ documentsRoots: [], publications: [] }),
    },
  };
  const event = (phase: string, extra: object) => ({
    event: 'agent',
    payload: {
      ...mapping,
      runId: 'run',
      stream: 'tool',
      data: { name: 'write', toolCallId: 'tool', phase, ...extra },
    },
  });
  await new EngineFiles(options).observe(
    event('start', {
      args: { path: 'documents/report.txt', content: 'RAW PRIVATE CONTENT' },
    }),
  );
  expect(rows.size).toBe(1);
  expect([...rows.keys()][0]).toMatch(/^publication-evidence:[a-f0-9]{64}$/);
  expect(JSON.stringify([...rows.values()])).not.toContain('RAW PRIVATE');
  expect(publish).not.toHaveBeenCalled();
  await new EngineFiles(options).observe(
    event('result', { isError: false, result: 'RAW PRIVATE RESULT' }),
  );
  expect(publish).toHaveBeenCalledExactlyOnceWith({ ...mapping, ...metadata });
  expect(rows.size).toBe(0);
  await new EngineFiles(options).observe(event('result', { isError: false }));
  expect(publish).toHaveBeenCalledTimes(1);
});
