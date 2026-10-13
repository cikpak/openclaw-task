import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nativeAgentFileRequest } from './native-agent-files.js';

describe('scoped native instruction-file double', () => {
  const scope = { agentId: 'selected', name: 'AGENTS.md' };
  it('reports missing files without inventing content or another agent’s file', () => {
    const files = new Map([['other', 'Private instructions.']]);
    expect(nativeAgentFileRequest(files, 'agents.files.get', scope)).toEqual({
      agentId: 'selected',
      file: { name: 'AGENTS.md', missing: true },
    });
    expect(files.size).toBe(1);
  });
  it('stores conditional writes and reads back exact UTF-8 content, size and hash', () => {
    const files = new Map<string, string>();
    const content = 'Résumé: answer clearly.\n';
    expect(
      nativeAgentFileRequest(files, 'agents.files.set', {
        ...scope,
        content,
        expectedMissing: true,
      }),
    ).toEqual({ ok: true });
    const hash = createHash('sha256').update(content).digest('hex');
    expect(nativeAgentFileRequest(files, 'agents.files.get', scope)).toEqual({
      agentId: 'selected',
      file: {
        name: 'AGENTS.md',
        missing: false,
        content,
        size: Buffer.byteLength(content),
        hash,
      },
    });
    nativeAgentFileRequest(files, 'agents.files.set', {
      ...scope,
      content: 'Updated',
      expectedHash: hash,
    });
    expect(files.get('selected')).toBe('Updated');
    expect(files.has('other')).toBe(false);
  });
  it('rejects stale or absent write preconditions without changing files', () => {
    const files = new Map([['selected', 'Existing']]);
    for (const condition of [
      {},
      { expectedMissing: true },
      { expectedHash: 'stale' },
    ])
      expect(() =>
        nativeAgentFileRequest(files, 'agents.files.set', {
          ...scope,
          content: 'Overwrite',
          ...condition,
        }),
      ).toThrow('changed before write');
    expect(files.get('selected')).toBe('Existing');
    expect(() =>
      nativeAgentFileRequest(files, 'agents.files.set', {
        ...scope,
        agentId: 'missing',
        content: 'Write',
      }),
    ).toThrow('changed before write');
    expect(files.has('missing')).toBe(false);
  });
  it('rejects unknown RPCs and out-of-contract filenames instead of arbitrary success', () => {
    const files = new Map<string, string>();
    expect(() =>
      nativeAgentFileRequest(files, 'agents.files.delete', scope),
    ).toThrow('Unexpected native file RPC');
    expect(() =>
      nativeAgentFileRequest(files, 'agents.files.get', {
        ...scope,
        name: '.env',
      }),
    ).toThrow();
    expect(() =>
      nativeAgentFileRequest(files, 'agents.files.get', {
        ...scope,
        agentId: '',
      }),
    ).toThrow();
    expect(files.size).toBe(0);
  });
});
