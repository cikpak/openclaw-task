import type { DurableLifecycle } from './index.js';

export async function wakeStep(core: DurableLifecycle): Promise<void> {
  const { state, driver } = core;
  if (state.phase === 'asleep') {
    if (!state.wantWake) return core.schedule(null);
    state.bootId = crypto.randomUUID();
    state.attemptId = crypto.randomUUID();
    core.move('waking');
    return;
  }
  if (state.phase === 'waking') {
    // Inspect before start: a persisted wake may refer to a disk that already exists.
    let container = await driver.inspect();
    if (!container.running) {
      await driver.start(state.bootId!);
      container = await driver.inspect();
      if (!container.running) return core.schedule(core.now() + 1000);
    }
    await driver.attach();
    if (container.bootId && container.bootId !== state.bootId) {
      // A boot different from the persisted attempt has lost its original local disk.
      state.bootId = container.bootId;
    }
    if (!state.initialized) {
      // This fence precedes initialization; an interrupted first boot cannot be
      // silently initialized again if its only disk subsequently disappears.
      state.initialized = true;
      core.newJob('initialize');
      core.move('initializing');
    } else if (state.checkpoint) {
      core.newJob('restore', state.checkpoint);
      core.move('restoring');
    } else core.failMissingCheckpoint();
    return;
  }
  if (state.phase === 'initializing' || state.phase === 'restoring') {
    const status = await core.pollJob();
    if (status?.state === 'complete') {
      state.job = null;
      core.move('connecting');
    }
    return;
  }
  if (state.phase === 'connecting') {
    if ((await driver.connect()) === false)
      return core.schedule(core.now() + 1000);
    state.wantWake = false;
    state.failure = null;
    state.retryPhase = null;
    state.idleSince = core.now();
    core.move('ready', core.now() + 1000);
    driver.dispatch?.(true);
    await driver.onReady?.();
  }
}

export async function cancelStep(core: DurableLifecycle): Promise<void> {
  const { state, driver } = core;
  if (state.phase === 'cancelling') {
    if (state.job) {
      await driver.helperCancel(state.job);
      const status = await core.statusJob();
      if (status.state === 'running') return core.schedule(core.now() + 1000);
      state.job = null;
    }
    // Native resume can fail once Gateway is stopped. Local helper restart remains
    // authoritative and must never run restore against this existing disk.
    try {
      await driver.resume(state.attemptId!);
    } catch {
      /* Stopped Gateway. */
    }
    core.newJob('resume');
    core.move('recovering');
    return;
  }
  if (state.phase === 'recovering') {
    const status = await core.pollJob();
    if (status?.state === 'complete') {
      state.job = null;
      state.pendingCheckpoint = null;
      core.move('connecting');
    }
  }
}
