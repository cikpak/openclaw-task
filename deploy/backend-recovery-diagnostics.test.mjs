import { afterEach, expect, it, vi } from 'vitest';
import {
  attachRecoveryDiagnostics,
  connectionCategory,
  recoveryError,
} from './backend-recovery-diagnostics.mjs';
it('classifies connector errors without returning embedded secrets', () => {
  expect(
    connectionCategory(
      new Error('certificate fingerprint mismatch private-key'),
    ),
  ).toBe('fingerprint');
  expect(
    connectionCategory(new Error('connect ECONNREFUSED private-host')),
  ).toBe('refused');
  expect(connectionCategory(new Error('private-content'))).toBe('other');
});
afterEach(() => vi.useRealTimers());
it('cannot replace an application failure when diagnostic output throws', async () => {
  const error = new Error('original failure');
  const gateway = { ready: false, history: vi.fn().mockRejectedValue(error) };
  const chats = {
    reconciled: false,
    reconcileAll: vi.fn().mockResolvedValue(undefined),
  };
  const store = { listChats: () => [], tombstones: () => [] };
  const stop = attachRecoveryDiagnostics({ gateway, chats, store }, () => {
    throw new Error('observer failure');
  });
  try {
    await expect(gateway.history()).rejects.toBe(error);
  } finally {
    stop();
  }
});
it('limits error diagnostics to known classifications, never upstream content', () => {
  expect(
    recoveryError({
      name: 'private-name',
      code: 'private-key',
      message: 'private-body',
      issues: [{ path: ['private-path'] }],
    }),
  ).toEqual({ name: 'other', code: 'other', issues: 1, detail: 'other' });
  expect(recoveryError({ name: 'ZodError', code: 'UNAVAILABLE' })).toEqual({
    name: 'ZodError',
    code: 'UNAVAILABLE',
    issues: 0,
    detail: 'other',
  });
});
it('preserves RPC results and failures while observing readiness without identities or payloads', async () => {
  vi.useFakeTimers();
  const error = Object.assign(new Error('private-message'), {
    code: 'UNAVAILABLE',
  });
  const gateway = {
    ready: true,
    client: { opts: { onConnectError: vi.fn() } },
    history: vi.fn().mockResolvedValue('private-result'),
    subscribe: vi.fn().mockRejectedValue(error),
  };
  const chats = {
    reconciled: false,
    reconcileAll: vi.fn().mockResolvedValue(undefined),
  };
  const store = {
    listChats: () => [{ id: 'private-chat' }],
    tombstones: () => [{ id: 'private-tombstone' }],
  };
  const rows = [];
  const history = gateway.history;
  const onConnectError = gateway.client.opts.onConnectError;
  const stop = attachRecoveryDiagnostics({ gateway, chats, store }, (line) =>
    rows.push(line),
  );
  try {
    expect(await gateway.history('private-parameters')).toBe('private-result');
    await expect(gateway.subscribe('private-parameters')).rejects.toBe(error);
    await chats.reconcileAll();
    await vi.advanceTimersByTimeAsync(1000);
    gateway.client.opts.onConnectError(
      new Error('connect ECONNREFUSED private-host'),
    );
    expect(rows.map((row) => JSON.parse(row).phase)).toEqual([
      'subscribe',
      'reconcile',
      'state',
      'onConnectError',
    ]);
    expect(rows.join('')).not.toContain('private-');
    expect(gateway.ready).toBe(true);
    expect(chats.reconciled).toBe(false);
    expect(history).toHaveBeenCalledWith('private-parameters');
    expect(onConnectError).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});
