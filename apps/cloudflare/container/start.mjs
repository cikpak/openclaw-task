import { randomUUID } from 'node:crypto';
import { mkdir, readdir, chown, chmod } from 'node:fs/promises';
import { root, runtime, environment } from './environment.mjs';
import { audit, initialize } from './configuration.mjs';
import { createSupervisor } from './processes.mjs';
import { pair } from './pairing.mjs';
import { fullMessage } from './full-message.mjs';
import { createJobs } from './jobs.mjs';
import { createRecovery } from './recovery.mjs';
import { filesBusy } from './files.mjs';
import { serve } from './http.mjs';
environment();
await mkdir(root, { recursive: true });
await mkdir(runtime, { recursive: true, mode: 0o700 });
await chmod(runtime, 0o700);
await chown(runtime, 0, 0);
const bootId = process.env.BOOT_ID ?? randomUUID();
const restoreExpected = process.env.RESTORE_EXPECTED === '1',
  initialRootEmpty = (await readdir(root)).length === 0;
let initialized = false,
  restored = false;
const supervisor = createSupervisor(),
  recovery = createRecovery();
const ready = async () => {
  if (!initialized || !restored)
    throw new Error('Verified initialization or recovery required');
  await audit();
};
const actions = {
  initialize: async (data, signal) => {
    signal.throwIfAborted();
    await supervisor.stopped();
    if (restoreExpected || initialized || !initialRootEmpty)
      throw new Error('Initialization forbidden');
    const result = await initialize(data);
    initialized = true;
    restored = true;
    return result;
  },
  start: async (_data, signal) => {
    await ready();
    await recovery.cleanup();
    return supervisor.start(signal);
  },
  stop: () => supervisor.stop(),
  pair: async (data, signal) => {
    await ready();
    if (supervisor.status() !== 'running')
      throw new Error('Gateway must be running');
    return pair(data.identity ?? data, signal);
  },
  'full-message': async (data, signal) => {
    await ready();
    if (supervisor.status() !== 'running')
      throw new Error('Gateway must be running');
    return { message: await fullMessage(data, signal) };
  },
  inspect: async (_data, signal) => {
    await supervisor.stopped();
    await ready();
    return recovery.inspect(signal);
  },
  capture: async (data, signal) => {
    if (filesBusy()) throw new Error('File handoff still active');
    await supervisor.stopped();
    await ready();
    const result = await recovery.capture(data, signal);
    await supervisor.stopped();
    return result;
  },
  upload: async (data, signal) => {
    await supervisor.stopped();
    await ready();
    return recovery.upload(data, signal);
  },
  restore: async (data, signal) => {
    await supervisor.stopped();
    if (!restoreExpected || restored || !initialRootEmpty)
      throw new Error('Restore forbidden');
    const result = await recovery.restore(data, signal);
    await audit();
    for (const path of [process.env.TMPDIR, process.env.XDG_CACHE_HOME]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chown(path, 1000, 1000);
    }
    initialized = true;
    restored = true;
    return result;
  },
};
const jobs = createJobs(bootId, actions);
const server = await serve(bootId, jobs, () => ({
  helperReady: true,
  filesBusy: filesBusy(),
  gatewayState: supervisor.status(),
  bootId,
  restoreExpected,
  initialized,
  restored,
  initialRootEmpty,
}));
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await jobs.settle();
      await supervisor.stop();
    } catch {
      /* Process may already have exited. */
    }
    server.closeAllConnections();
    server.close();
    process.exit(0);
  });
console.info(JSON.stringify({ event: 'helper-ready', bootId }));
