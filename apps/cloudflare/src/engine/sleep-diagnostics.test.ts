import { expect, it, vi } from 'vitest';
import { SleepDiagnostics, type SleepActivity } from './sleep-diagnostics.js';
import type { LifecycleState } from './lifecycle/types.js';

const privateValue =
  'PRIVATE-TOKEN /recovery/private session-id object/key checkpoint-id';
function fixture() {
  let now = 100_000;
  const lines: string[] = [];
  const diagnostics = new SleepDiagnostics(
    (line) => lines.push(line),
    () => now,
  );
  return {
    diagnostics,
    lines,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const activity: SleepActivity = {
  liveReaders: false,
  fileWork: false,
  pendingMessages: 0,
  creatingChats: 0,
  deletingChats: 0,
  runningChats: 0,
  settingsOperations: 0,
  driving: 0,
  steering: 0,
  streams: 0,
  reconciliation: false,
  locks: 0,
  gatewayReady: false,
};
const state: LifecycleState = {
  phase: 'capturing',
  initialized: true,
  failure: 'save',
  retryPhase: null,
  wantWake: false,
  bootId: privateValue,
  attemptId: privateValue,
  checkpoint: {
    generation: privateValue,
    manifestKey: privateValue,
    manifestSha256: privateValue,
    descriptor: { secret: privateValue },
  },
  pendingCheckpoint: null,
  job: {
    id: privateValue,
    attemptId: privateValue,
    bootId: privateValue,
    kind: 'capture',
  },
  idleSince: 10_000,
  jobStartedAt: 80_000,
  retryAt: 110_000,
  leaseUntil: 120_000,
  nextAt: 100_001,
};
it('reports loaded durable capture phase and finite busy causes without cloning or serializing private descriptors', () => {
  const f = fixture();
  const guarded = {
    ...state,
    checkpoint: {
      toJSON: () => {
        throw new Error('Do not serialize descriptor');
      },
    },
  } as unknown as LifecycleState;
  f.diagnostics.lifecycle(
    guarded,
    {
      ...activity,
      driving: 2,
      reconciliation: true,
      locks: 1,
      private: privateValue,
    } as SleepActivity,
    true,
  );
  expect(JSON.parse(f.lines[0]!)).toMatchObject({
    event: 'engine-sleep',
    observation: 'lifecycle',
    source: 'loaded',
    phase: 'capturing',
    failure: 'save',
    jobKind: 'capture',
    hasCheckpoint: true,
    driving: 2,
    reconciliation: true,
    locks: 1,
    pendingMessages: 0,
    jobAgeMs: 20_000,
    idleAgeMs: 90_000,
    retryInMs: 10_000,
    leaseInMs: 20_000,
  });
  expect(f.lines.join('')).not.toContain(privateValue);
  for (const key of [
    'bootId',
    'attemptId',
    'descriptor',
    'manifestKey',
    'secret',
  ])
    expect(f.lines.join('')).not.toContain(key);
});
it('does not turn changing ages into one-second log spam and reports actual state changes', () => {
  const f = fixture();
  f.diagnostics.lifecycle(state, activity);
  for (let n = 0; n < 100; n++) {
    f.advance(1000);
    f.diagnostics.lifecycle(state, activity);
  }
  expect(f.lines).toHaveLength(1);
  f.diagnostics.lifecycle({ ...state, phase: 'cancelling' }, activity);
  expect(f.lines).toHaveLength(2);
  expect(JSON.parse(f.lines[1]!)).toMatchObject({
    phase: 'cancelling',
    jobAgeMs: 120_000,
  });
  f.advance(300_000);
  f.diagnostics.lifecycle({ ...state, phase: 'cancelling' }, activity);
  expect(f.lines).toHaveLength(3);
});
it('reports native blocker counts and write custody while dropping raw names, messages and unexpected fields', () => {
  const f = fixture();
  f.diagnostics.suspension({
    status: 'draining',
    suspensionId: privateValue,
    token: privateValue,
    activeCount: 4,
    blockers: [
      { kind: 'terminal-persistence', count: 2, message: privateValue },
      { kind: 'queued-turn', count: 1, message: privateValue },
      { kind: privateValue, count: 1, message: privateValue },
    ],
    writeCustody: [{ phase: privateValue, count: 2 }],
  });
  expect(JSON.parse(f.lines[0]!)).toMatchObject({
    observation: 'suspension',
    status: 'draining',
    activeCount: 4,
    blockers: { 'terminal-persistence': 2, 'queued-turn': 1, other: 1 },
    writeCustodyPresent: true,
    writeCustodyShape: 'array',
    writeCustodyCount: 2,
  });
  expect(f.lines.join('')).not.toContain(privateValue);
  f.diagnostics.suspension({
    status: privateValue,
    reason: privateValue,
    activeCount: Infinity,
  });
  expect(JSON.parse(f.lines[1]!)).toMatchObject({
    status: 'other',
    reason: 'other',
    activeCount: 0,
    writeCustodyPresent: false,
    writeCustodyCount: null,
  });
  f.diagnostics.suspension({
    status: 'ready',
    writeCustody: { secret: privateValue },
  });
  expect(JSON.parse(f.lines[2]!)).toMatchObject({
    writeCustodyPresent: true,
    writeCustodyShape: 'other',
    writeCustodyCount: null,
  });
  expect(f.lines.join('')).not.toContain(privateValue);
});
it('sorts blocker categories so reordered native responses do not emit duplicate observations', () => {
  const f = fixture();
  const blockers = [
    { kind: 'queued-turn', count: 1 },
    { kind: 'chat-run', count: 2 },
  ];
  f.diagnostics.suspension({ status: 'draining', blockers });
  f.diagnostics.suspension({
    status: 'draining',
    blockers: blockers.toReversed(),
  });
  expect(f.lines).toHaveLength(1);
});
it('bounds noisy changes per channel and resumes reporting after the rate window', () => {
  const f = fixture();
  for (let n = 0; n < 100; n++)
    f.diagnostics.helper('capture', 'primary', n % 2 ? 'running' : 'failed');
  expect(f.lines).toHaveLength(20);
  f.advance(60_001);
  f.diagnostics.helper('capture', 'upload', 'failed');
  expect(f.lines).toHaveLength(21);
  expect(JSON.parse(f.lines.at(-1)!)).toMatchObject({
    jobKind: 'capture',
    stage: 'upload',
    status: 'failed',
  });
});
it('contains hostile phase and helper values and never exposes exception text', () => {
  const f = fixture();
  f.diagnostics.lifecycle(
    {
      ...state,
      phase: privateValue,
      failure: privateValue,
    } as unknown as LifecycleState,
    activity,
  );
  f.diagnostics.helper(privateValue, privateValue, privateValue);
  f.diagnostics.failure(privateValue, new Error(privateValue));
  expect(f.lines.join('')).not.toContain(privateValue);
  expect(JSON.parse(f.lines[0]!)).toMatchObject({
    phase: 'other',
    failure: 'other',
  });
  expect(JSON.parse(f.lines[1]!)).toMatchObject({
    jobKind: 'other',
    stage: 'other',
    status: 'other',
  });
  f.diagnostics.failure('capturing', new Error('Helper operation failed'));
  expect(JSON.parse(f.lines[3]!)).toMatchObject({
    phase: 'capturing',
    reason: 'helper-failed',
  });
});
it('keeps logger failures out of engine control flow', () => {
  const output = vi.fn(() => {
    throw new Error('Logger unavailable');
  });
  const diagnostics = new SleepDiagnostics(output);
  expect(() => diagnostics.lifecycle(state, activity)).not.toThrow();
  expect(() => diagnostics.suspension({ status: 'ready' })).not.toThrow();
  expect(() =>
    diagnostics.helper('capture', 'primary', 'failed'),
  ).not.toThrow();
  expect(() =>
    diagnostics.failure('capturing', new Error(privateValue)),
  ).not.toThrow();
  expect(output).toHaveBeenCalledTimes(4);
});
