import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writerEvidence } from '../../test/acceptance/container/gateway-writer-evidence.mjs';
import { crashCategory } from '../../test/acceptance/container/gateway-diagnostic.mjs';
import { crashGateway } from '../../test/acceptance/container/gateway-crash.mjs';
import { restartGateway } from '../../apps/cloudflare/test/acceptance-restart.ts';
const target = { pid: 20, group: 20, start: '100' };
const row = (pid, parent, patch = {}) => ({
  pid,
  parent,
  group: pid,
  start: `${pid}`,
  uid1000: true,
  ...patch,
});
test('writer observations distinguish stable descendants, reused PIDs and unrelated writers', () => {
  const before = [
    row(20, 1, { start: '100' }),
    row(21, 20),
    row(22, 21),
    row(23, 1),
  ];
  const after = [
    row(21, 1),
    row(22, 1, { start: 'reused' }),
    row(23, 1),
    row(24, 7),
  ];
  const evidence = writerEvidence(target, before, after, 7);
  assert.deepEqual(evidence, {
    beforeAvailable: true,
    afterAvailable: true,
    remainingUid1000: 4,
    sameGatewayGroup: 0,
    provenDescendants: 1,
    unassociatedUid1000: 3,
    parentIsHelper: 1,
  });
  assert.ok(
    Object.values(evidence).every((value) =>
      ['boolean', 'number'].includes(typeof value),
    ),
  );
  assert.equal(writerEvidence(target, undefined, after).provenDescendants, 0);
  assert.equal(writerEvidence(target, before, undefined).afterAvailable, false);
});
test('only exact fixed production writer errors become safe categories', () => {
  for (const [message, category] of [
    ['Detached engine writer remains', 'detached-engine-writer'],
    ['Recovery writer descriptor remains', 'recovery-descriptor-writer'],
    ['Cannot verify process ownership', 'writer-ownership-unverified'],
    ['Cannot verify recovery descriptor', 'writer-descriptor-unverified'],
    ['private descriptor path', 'crash-operation-rejected'],
    ['__proto__', 'crash-operation-rejected'],
  ])
    assert.equal(crashCategory(Error(message)), category);
});
test('writer rejection captures safe metadata after failure without changing signal guards', async () => {
  const previous = process.env.MESSENGER_ACCEPTANCE_FIXTURE;
  process.env.MESSENGER_ACCEPTANCE_FIXTURE = '1';
  const calls = [];
  try {
    await assert.rejects(
      crashGateway({
        registry: { target: async () => target },
        snapshot: async () => {
          calls.push('snapshot');
          return [row(20, 1, { start: '100' }), row(21, 20)];
        },
        readProcess: async () => {
          calls.push('identity');
          return {
            ...target,
            state: 'S',
            uids: [1000, 1000, 1000, 1000],
            command: ['openclaw-gateway'],
          };
        },
        kill: () => calls.push('signal'),
        members: async () => [],
        verify: async () => {
          throw Error('Cannot verify process ownership');
        },
      }),
      (error) =>
        error.code === 'writer-ownership-unverified' &&
        error.phase === 'writers' &&
        error.writerEvidence.provenDescendants === 2,
    );
    assert.deepEqual(calls, ['snapshot', 'identity', 'signal', 'snapshot']);
  } finally {
    if (previous === undefined) delete process.env.MESSENGER_ACCEPTANCE_FIXTURE;
    else process.env.MESSENGER_ACCEPTANCE_FIXTURE = previous;
  }
});
test('test control strips private writer metadata and rejects malformed count fields', async () => {
  const evidence = writerEvidence(target, [], []);
  for (const patch of [
    { secret: 'private metadata' },
    { remainingUid1000: -1 },
  ]) {
    const response = await restartGateway({
      action: async () => ({
        crashed: false,
        category: 'detached-engine-writer',
        phase: 'writers',
        writerEvidence: { ...evidence, ...patch },
      }),
      health: async () => ({ gatewayState: 'stopped' }),
    });
    const value = await response.json();
    assert.equal(value.reason, 'detached-engine-writer');
    assert.equal(JSON.stringify(value).includes('private metadata'), false);
    assert.equal(
      Boolean(value.writerEvidence),
      !Object.hasOwn(patch, 'remainingUid1000'),
    );
  }
});
