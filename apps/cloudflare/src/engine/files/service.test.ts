import { describe, expect, it, vi } from 'vitest';
import { EngineFiles } from './service.js';
const mapping = { agentId: 'a', sessionKey: 'agent:a:main' };
const metadata = {
  path: '/recovery/a/documents/report.txt',
  documentsRoot: '/recovery/a/documents',
  name: 'report.txt',
  mimeType: 'text/plain',
  size: 4,
  modifiedAt: 1,
};
function setup() {
  const publish = vi.fn(() =>
    Promise.resolve({
      id: 'opaque-random',
      name: 'report.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
      updatedAt: 1,
      category: 'deliverable' as const,
    }),
  );
  const helper = vi.fn(() => Promise.resolve(Response.json(metadata)));
  const service = new EngineFiles({
    helper,
    mapping: (key) => (key === mapping.sessionKey ? mapping : null),
    catalog: {
      publish,
      policy: () => ({ documentsRoots: [], publications: [] }),
      records: () => [],
      revoke: () => Promise.resolve(),
    },
  });
  const event = (
    phase: string,
    extra = {},
    sessionKey = mapping.sessionKey,
    runId = 'run',
  ) =>
    service.observe({
      event: 'agent',
      payload: {
        sessionKey,
        runId,
        stream: 'tool',
        data: { toolCallId: 'call', phase, name: 'write', ...extra },
      },
    });
  return { service, helper, publish, event };
}
describe('private native file evidence', () => {
  it('publishes only correlated successful write/edit evidence after helper verifies scope', async () => {
    const { event, helper, publish } = setup();
    await event('result', { isError: false });
    expect(helper).not.toHaveBeenCalled();
    await event('start', {
      args: { path: 'documents/report.txt', content: 'RAW PRIVATE BODY' },
    });
    expect(publish).not.toHaveBeenCalled();
    await event('result', { isError: false, result: 'RAW PRIVATE RESULT' });
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      ...mapping,
      ...metadata,
    });
    expect(JSON.stringify(publish.mock.calls)).not.toContain('RAW PRIVATE');
  });
  it('rejects failed/mismatched/unknown-session/private outputs and ignores placement without evidence', async () => {
    const { event, helper, publish } = setup();
    await event('start', { args: { path: 'documents/report.txt' } });
    await event('result', { isError: true });
    await event('start', { args: { path: 'documents/report.txt' } });
    await event('result', { isError: false }, mapping.sessionKey, 'wrong-run');
    await event(
      'start',
      { args: { path: 'documents/report.txt' } },
      'agent:b:main',
    );
    expect(helper).not.toHaveBeenCalled();
    helper.mockImplementationOnce(() =>
      Promise.resolve(new Response('{}', { status: 400 })),
    );
    await event('result', { isError: false });
    expect(publish).not.toHaveBeenCalled();
  });
});

it('clears the pre-admission deadline so admitted large transfers outlive two minutes', async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const files = new EngineFiles({
      helper: (_path, init) => {
        signal = init?.signal ?? undefined;
        return Promise.resolve(new Response('active streamed body'));
      },
      mapping: () => mapping,
      catalog: {
        publish: () => Promise.reject(new Error('unused')),
        policy: () => ({ documentsRoots: [], publications: [] }),
        records: () => [],
        revoke: () => Promise.resolve(),
      },
    });
    const response = await files.read(mapping, metadata.path);
    await vi.advanceTimersByTimeAsync(180000);
    expect(signal?.aborted).toBe(false);
    expect(await response.text()).toBe('active streamed body');
  } finally {
    vi.useRealTimers();
  }
});
it('emits only verified concise eligible publication summaries without raw arguments/results', async () => {
  const summary = vi.fn();
  const file = {
    id: 'opaque-id',
    name: metadata.name,
    mimeType: metadata.mimeType,
    sizeBytes: metadata.size,
    updatedAt: 1,
    category: 'deliverable' as const,
  };
  let published = false;
  const files = new EngineFiles({
    helper: () => Promise.resolve(Response.json(metadata)),
    mapping: () => mapping,
    summary,
    catalog: {
      publish: () => {
        published = true;
        return Promise.resolve(file);
      },
      revoke: () => {
        published = false;
        return Promise.resolve();
      },
      records: () => [],
      policy: () => ({
        documentsRoots: [metadata.documentsRoot],
        publications: published
          ? [{ nativePath: metadata.path, classification: 'deliverable', file }]
          : [],
      }),
    },
  });
  for (const [phase, extra] of [
    [
      'start',
      { args: { path: 'documents/report.txt', content: 'secret tool body' } },
    ],
    ['result', { isError: false, result: 'secret raw output' }],
  ] as const) {
    await files.observe({
      event: 'agent',
      payload: {
        ...mapping,
        runId: 'run',
        stream: 'tool',
        data: { phase, toolCallId: 'tool', name: 'write', ...extra },
      },
    });
  }
  expect(summary).toHaveBeenCalledExactlyOnceWith(mapping, {
    id: 'run:tool',
    operation: 'write',
    status: 'completed',
    text: 'Wrote report.txt',
    fileId: 'opaque-id',
  });
  expect(JSON.stringify(summary.mock.calls)).not.toContain('secret');
});
it('awaits fresh asynchronous private credentials for input metadata audits', async () => {
  const helper = vi.fn((_path: string, init?: RequestInit) => {
    const body = init?.body;
    if (typeof body !== 'string')
      throw new Error('Expected private JSON request');
    expect(JSON.parse(body)).toMatchObject({
      ...mapping,
      id: 'input',
      secrets: ['fresh-native-device-token'],
    });
    return Promise.resolve(
      Response.json({
        digest: 'a'.repeat(64),
        size: 4,
        path: '/private/input',
        name: 'a.txt',
        mimeType: 'text/plain',
      }),
    );
  });
  const files = new EngineFiles({
    helper,
    mapping: () => mapping,
    secrets: () => Promise.resolve(['fresh-native-device-token']),
    catalog: {
      publish: () => Promise.reject(new Error('unused')),
      revoke: () => Promise.resolve(),
      records: () => [],
      policy: () => ({ documentsRoots: [], publications: [] }),
    },
  });
  expect((await files.inputMetadata(mapping, 'input')).digest).toBe(
    'a'.repeat(64),
  );
  expect(helper).toHaveBeenCalledOnce();
});
