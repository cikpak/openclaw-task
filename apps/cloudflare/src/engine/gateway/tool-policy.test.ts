import { expect, it, vi } from 'vitest';
import { ensureDirectToolLoading } from './tool-policy.js';
function snapshot(loading = 'searchable', applied = true) {
  return {
    valid: true,
    hash: loading === 'direct' ? 'direct-cas-hash' : 'fresh-cas-hash',
    configRevisionHash: 'resolved-revision',
    appliedConfigHash: applied ? 'resolved-revision' : 'previous-revision',
    config: {
      gateway: { reload: { mode: 'hybrid' } },
      tools: { allow: ['read', 'write', 'edit'] },
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: { codexDynamicToolsLoading: loading, unrelated: 'keep' },
          },
          unrelated: { enabled: false, config: { private: 'never-forward' } },
        },
      },
    },
  };
}

it('migrates restored configuration with only the supported field and fresh CAS hash', async () => {
  const original = snapshot();
  const request = vi
    .fn()
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce({ ok: true, hash: 'direct-cas-hash' })
    .mockResolvedValueOnce(snapshot('direct'));
  expect(await ensureDirectToolLoading(request)).toBe(true);
  expect(request.mock.calls).toEqual([
    ['config.get', {}],
    [
      'config.patch',
      {
        raw: JSON.stringify({
          plugins: {
            entries: {
              codex: { config: { codexDynamicToolsLoading: 'direct' } },
            },
          },
        }),
        baseHash: 'fresh-cas-hash',
      },
    ],
    ['config.get', {}],
  ]);
  expect(original).toEqual(snapshot());
  expect(JSON.stringify(request.mock.calls)).not.toContain('never-forward');
  expect(JSON.stringify(request.mock.calls)).not.toContain('tools');
});

it('does not rewrite an already applied direct configuration', async () => {
  const request = vi.fn().mockResolvedValue(snapshot('direct'));
  expect(await ensureDirectToolLoading(request)).toBe(true);
  expect(request.mock.calls).toEqual([['config.get', {}]]);
});

it('keeps persisted direct mode closed until native runtime application completes', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(snapshot('direct', false))
    .mockResolvedValueOnce(snapshot('direct'));
  expect(await ensureDirectToolLoading(request)).toBe(false);
  expect(await ensureDirectToolLoading(request)).toBe(true);
  expect(request.mock.calls).toEqual([
    ['config.get', {}],
    ['config.get', {}],
  ]);
});

it.each(['searchable', 'direct'])(
  'never requests a restart when reload is off (%s)',
  async (loading) => {
    const value = snapshot(loading, false);
    value.config.gateway.reload.mode = 'off';
    const request = vi.fn().mockResolvedValue(value);
    expect(await ensureDirectToolLoading(request)).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it('does not patch over an unapplied unrelated configuration revision', async () => {
  const request = vi.fn().mockResolvedValue(snapshot('searchable', false));
  expect(await ensureDirectToolLoading(request)).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([{}, { ...snapshot(), valid: false }, { ...snapshot(), hash: null }])(
  'keeps dispatch closed for an invalid configuration response',
  async (value) => {
    const request = vi.fn().mockResolvedValue(value);
    expect(await ensureDirectToolLoading(request)).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it('never treats persistence alone as active runtime application', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce({ ok: true, hash: 'direct-cas-hash' })
    .mockResolvedValueOnce(snapshot('direct', false));
  expect(await ensureDirectToolLoading(request)).toBe(false);
});

it('keeps a native CAS conflict closed without a blind patch replay', async () => {
  const conflict = Error('controlled native conflict');
  const request = vi
    .fn()
    .mockResolvedValueOnce(snapshot())
    .mockRejectedValueOnce(conflict)
    .mockResolvedValueOnce(snapshot());
  expect(await ensureDirectToolLoading(request)).toBe(false);
  expect(request).toHaveBeenCalledTimes(3);
});

it.each(['off', 'restart', 'unknown'])(
  'refuses unsafe reload mode %s before writing',
  async (mode) => {
    const value = snapshot();
    value.config.gateway.reload.mode = mode;
    const request = vi.fn().mockResolvedValue(value);
    expect(await ensureDirectToolLoading(request)).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it('fails closed after native active work prevents automatic plugin activation', async () => {
  const unavailable = Object.assign(Error('native active work drain'), {
    code: 'UNAVAILABLE',
    details: { persistedConfig: { hash: 'direct-cas-hash' } },
  });
  const first = vi
    .fn()
    .mockResolvedValueOnce(snapshot())
    .mockRejectedValueOnce(unavailable)
    .mockResolvedValueOnce(snapshot('direct', false));
  expect(await ensureDirectToolLoading(first)).toBe(false);
  const reconstructed = vi.fn().mockResolvedValue(snapshot('direct', false));
  expect(await ensureDirectToolLoading(reconstructed)).toBe(false);
  expect(reconstructed.mock.calls).toEqual([['config.get', {}]]);
});

it('does not turn an uncertain patch ACK into an automatic reload', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(snapshot())
    .mockRejectedValueOnce(Error('timeout'))
    .mockResolvedValue(snapshot('direct', false));
  expect(await ensureDirectToolLoading(request)).toBe(false);
  expect(await ensureDirectToolLoading(request)).toBe(false);
  expect(
    request.mock.calls.filter(([method]) => method === 'plugins.reload'),
  ).toHaveLength(0);
});

it('accepts a lost patch ACK only after authoritative direct and applied revision proof', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(snapshot())
    .mockRejectedValueOnce(Error('timeout'))
    .mockResolvedValueOnce(snapshot('direct'));
  expect(await ensureDirectToolLoading(request)).toBe(true);
});

it.each(['hot', 'default'])(
  'supports native %s reload without changing that policy',
  async (mode) => {
    const initial = snapshot();
    if (mode === 'default')
      Reflect.deleteProperty(initial.config.gateway.reload, 'mode');
    else initial.config.gateway.reload.mode = mode;
    const request = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ ok: true, hash: 'direct-cas-hash' })
      .mockResolvedValueOnce(snapshot('direct'));
    expect(await ensureDirectToolLoading(request)).toBe(true);
    expect(
      JSON.parse((request.mock.calls[1]?.[1] as { raw: string }).raw),
    ).not.toHaveProperty('gateway');
  },
);

it('keeps dispatch closed when a foreign unapplied revision appears after patch', async () => {
  const foreign = { ...snapshot('direct', false), hash: 'foreign-revision' };
  const request = vi
    .fn()
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce(foreign);
  expect(await ensureDirectToolLoading(request)).toBe(false);
});
