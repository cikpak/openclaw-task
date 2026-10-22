import type { DurableLifecycle } from './index.js';

export async function sleepStep(core: DurableLifecycle): Promise<void> {
  const { state, driver } = core;
  if (state.phase === 'ready') {
    if (await driver.busy()) {
      state.idleSince = core.now();
      return core.schedule(core.now() + 1000);
    }
    state.idleSince ??= core.now();
    const idleAt = Math.max(state.idleSince + core.idleMs, state.retryAt);
    if (core.now() < idleAt)
      return core.schedule(Math.min(idleAt, core.now() + 1000));
    driver.dispatch?.(false);
    state.attemptId = crypto.randomUUID();
    state.wantWake = false;
    core.move('preparing');
    return;
  }
  if (state.phase === 'preparing') {
    if (state.wantWake || driver.pending()) return core.cancel();
    // Calling prepare again renews its lease; status polling alone does not.
    const lease = await driver.prepare(state.attemptId!);
    state.leaseUntil = lease.expiresAt;
    if (lease.expiresAt <= core.now()) throw new Error('Suspend lease expired');
    if (lease.ready && !(await driver.busy())) core.move('stopping-writers');
    else
      await core.schedule(
        core.now() +
          Math.min(1000, Math.max(1, (lease.expiresAt - core.now()) / 2)),
      );
    return;
  }
  if (state.phase === 'stopping-writers') {
    if (state.wantWake || driver.pending()) return core.cancel();
    await driver.stopWriters();
    driver.disconnect();
    core.newJob('capture');
    core.move('capturing');
    return;
  }
  if (state.phase === 'capturing') {
    const result = await core.pollJob();
    if (result?.state === 'complete') {
      if (!result.checkpoint) throw new Error('Capture returned no checkpoint');
      state.pendingCheckpoint = result.checkpoint;
      state.job = null;
      core.move('verifying');
    }
    return;
  }
  if (state.phase === 'verifying') {
    await driver.verifyCheckpoint(state.pendingCheckpoint!);
    core.move('committing');
    return;
  }
  if (state.phase === 'committing') {
    const checkpoint = state.pendingCheckpoint!;
    const previous = state.checkpoint;
    try {
      core.repository.transaction(() => {
        driver.commit(checkpoint);
        state.checkpoint = checkpoint;
        core.repository.save(state);
      });
    } catch (error) {
      state.checkpoint = previous;
      throw error;
    }
    // Synchronous check, persisted fence, and destroy invocation are serialized.
    // Once fenced, even an uncertain destroy must finish before any restore.
    if (state.wantWake || driver.pending()) return core.cancel();
    core.move('stop-issued');
    await driver.destroy();
    await stopped(core);
    return;
  }
  if (state.phase === 'stop-issued') {
    if ((await driver.inspect()).running) await driver.destroy();
    await stopped(core);
  }
}

async function stopped(core: DurableLifecycle): Promise<void> {
  if ((await core.driver.inspect()).running)
    return core.schedule(core.now() + 1000);
  core.state.bootId = null;
  core.state.job = null;
  core.state.pendingCheckpoint = null;
  core.move(
    'asleep',
    core.state.wantWake || core.driver.pending() ? core.now() + 1 : null,
  );
  if (core.driver.pending()) core.state.wantWake = true;
}
