import { ownedPortClosed } from './cleanup-port.mjs';
import { cleanupContainers } from './cleanup-containers.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
const execute = (command, args) =>
  promisify(execFile)(command, args, { timeout: 15000, killSignal: 'SIGKILL' });
export async function cleanupOwnedRuntime(
  runner,
  env,
  preexistingContainerIds,
  path,
  effects = {},
) {
  const run = effects.execute ?? execute;
  const pause = effects.delay ?? delay;
  const portClosed = effects.portClosed ?? ownedPortClosed;
  const persist = effects.writeFile ?? writeFile;
  const namespace = env.CLOUDFLARE_WORKSPACE_ID;
  assert.match(namespace, /^[a-f0-9]{12}$/u);
  assert.equal(env.ACCEPTANCE_PROJECT, `messenger-acceptance-${namespace}`);
  const errors = [];
  const result = {
    namespace,
    preexistingContainerIds,
    removedContainerIds: [],
    portsClosed: [],
    preexistingStillRunning: false,
    ownedAbsent: false,
    cleanupFailureSteps: [],
    dockerObservations: [],
  };
  const failure = (step) => {
    result.cleanupFailureSteps.push(step);
    errors.push(new Error(`Exact cleanup failed: ${step}`));
  };
  const running = () => runner.exitCode === null && runner.signalCode === null;
  try {
    if (running()) {
      runner.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => runner.once('exit', resolve)),
        pause(16000),
      ]);
      if (running()) {
        failure('runner-shutdown');
        runner.kill('SIGKILL');
      }
    }
  } catch {
    failure('runner-shutdown');
  }
  await cleanupContainers(run, namespace, result, failure, {
    delay: pause,
    now: effects.now ?? Date.now,
  });
  for (const origin of [env.ACCEPTANCE_ORIGIN, env.ACCEPTANCE_HARNESS_ORIGIN]) {
    let closed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        closed = await portClosed(origin);
      } catch {
        // A failed/unknown probe is not proof of a closed listener.
      }
      if (closed) break;
      await pause(100);
    }
    result.portsClosed.push({ origin, closed });
    if (!closed) failure('owned-port-open');
  }
  try {
    const { stdout } = await run('docker', ['ps', '-q']);
    const alive = stdout.trim().split(/\s+/u);
    result.preexistingStillRunning = preexistingContainerIds.every((id) =>
      alive.includes(id),
    );
    if (!result.preexistingStillRunning)
      failure('preexisting-container-missing');
  } catch {
    failure('preexisting-verification');
  }
  result.completedAt = Date.now();
  try {
    await persist(path, JSON.stringify(result, null, 2), { mode: 0o600 });
  } catch {
    failure('cleanup-evidence-write');
  }
  if (errors.length)
    throw new AggregateError(errors, 'Exact owned runtime cleanup failed');
  return result;
}
