import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { containerControl } from './native-followup-container.mjs';
import { providerConfig } from './native-followup-config.mjs';
import { restoreFixture } from './native-followup-restore.mjs';
import { bootstrapReady } from './native-followup-readiness.mjs';
const app = resolve(import.meta.dirname, '..');
const WebSocket = createRequire(resolve(app, '../backend/package.json'))('ws');
export async function until(work, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await work();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
export async function fixture(providerUrl, recovery) {
  const image = process.env.OPENCLAW_TEST_IMAGE;
  assert.match(
    image ?? '',
    /^sha256:[a-f0-9]{64}$/u,
    'Select an immutable production image',
  );
  const directory = await mkdtemp(resolve(tmpdir(), 'native-followup-'));
  const compiled = resolve(
    app,
    'node_modules/.cache/native-followup/native.mjs',
  );
  await mkdir(resolve(compiled, '..'), { recursive: true });
  await build({
    entryPoints: [resolve(app, 'src/engine/gateway/native.ts')],
    outfile: compiled,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  const { NativeGateway } = await import(pathToFileURL(compiled).href);
  const helperToken = randomBytes(32).toString('hex'),
    gatewayToken = randomBytes(32).toString('hex');
  const values = new Map();
  const control = containerControl(
    image,
    helperToken,
    gatewayToken,
    recovery.origin,
  );
  const { node, job, docker } = control;
  let pairPending = 0,
    pairDone = 0;
  let pairing = Promise.resolve(),
    bootstrap;
  const pairingStatus = () => ({ pending: pairPending, completed: pairDone });
  const gateway = new NativeGateway({
    storage: {
      get: async (key) => values.get(key),
      put: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => values.delete(key),
    },
    gatewayToken,
    pair: async (identity) => {
      pairPending++;
      try {
        pairing = job('pair', { identity });
        await pairing;
        pairDone++;
      } finally {
        pairPending--;
      }
    },
    fetcher: () => ({
      fetch: (_url, options) =>
        new Promise((accept, reject) => {
          const socket = new WebSocket(control.origin().replace('http', 'ws'));
          socket.accept = () => {};
          options?.signal?.addEventListener('abort', () => socket.close(), {
            once: true,
          });
          socket.once('error', reject);
          socket.once('open', () =>
            accept({ status: 101, webSocket: socket, body: null }),
          );
        }),
    }),
  });
  const identity = await gateway.identity();
  const start = async () => {
    await job('start');
    gateway.start();
    bootstrap = await bootstrapReady(
      gateway,
      control,
      () => pairing,
      pairingStatus,
    );
    gateway.dispatch(true);
  };
  const close = async () => {
    const results = await Promise.allSettled([
      gateway.stop(),
      control.close(),
      rm(directory, { recursive: true, force: true }),
    ]);
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length)
      throw new AggregateError(failures, 'Native fixture cleanup failed');
  };
  try {
    await control.launch(identity);
    await job('initialize', {
      identity,
      config: await providerConfig(control, providerUrl),
    });
    return {
      gateway,
      node,
      job,
      start,
      restore: () =>
        restoreFixture({ gateway, control, identity, start, recovery }),
      image,
      directory,
      docker,
      name: control.name,
      pairingStatus,
      bootstrapStatus: () => bootstrap,
      jobStatus: control.jobStatus,
      close,
    };
  } catch (error) {
    await close().catch(() =>
      console.error('Native fixture startup cleanup failed'),
    );
    throw error;
  }
}
