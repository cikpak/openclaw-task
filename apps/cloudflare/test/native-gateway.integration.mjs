import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { verifyNativePagination } from './native-history-pagination.mjs';
const exec = promisify(execCallback);
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireBackend = createRequire(resolve(app, '../backend/package.json'));
const WebSocket = requireBackend('ws');
const directory = resolve(app, 'node_modules/.cache/native-auth');
await mkdir(directory, { recursive: true });
await build({
  entryPoints: [resolve(app, 'src/engine/gateway/native.ts')],
  outfile: resolve(directory, 'native.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
const { NativeGateway } = await import(
  pathToFileURL(resolve(directory, 'native.mjs')).href
);
let name = `phase3-gateway-auth-${randomUUID().slice(0, 8)}`;
let bootId = randomUUID();
const containerNames = new Set([name]);
const image = process.env.OPENCLAW_TEST_IMAGE;
if (!image)
  throw new Error(
    'Run pnpm test:engine or select OPENCLAW_TEST_IMAGE explicitly',
  );
const helperToken = randomBytes(32).toString('hex');
const gatewayToken = randomBytes(32).toString('hex');
const values = new Map();
const storage = {
  get: async (key) => values.get(key),
  put: async (key, value) => {
    values.set(key, value);
  },
  delete: async (key) => values.delete(key),
};
let gatewayOrigin, helperOrigin;
let pairCalls = 0;
let upgrades = 0;
const fetcher = {
  fetch: (_url, options) =>
    new Promise((resolveUpgrade, reject) => {
      const socket = new WebSocket(gatewayOrigin.replace('http', 'ws'));
      socket.accept = () => {};
      const abort = () => socket.close();
      options?.signal?.addEventListener('abort', abort, { once: true });
      socket.once('error', reject);
      socket.once('open', () => {
        upgrades++;
        resolveUpgrade({ status: 101, webSocket: socket, body: null });
      });
    }),
};
async function request(path, body) {
  const response = await fetch(helperOrigin + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${helperToken}`,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `Helper HTTP ${response.status}`);
  return response.json();
}
async function job(action, data) {
  let operation = await request('/jobs', {
    operationId: randomUUID(),
    bootId,
    action,
    data,
  });
  const deadline = Date.now() + 300000;
  while (operation.status === 'running' && Date.now() < deadline) {
    await delay(100);
    operation = await request(`/jobs/${operation.operationId}`);
  }
  if (operation.status === 'failed' && action === 'full-message') {
    const diagnostic = await exec('docker', [
      'exec',
      name,
      'node',
      '--input-type=module',
      '-e',
      `import { fullMessage } from '/opt/messenger-helper/full-message.mjs'; try { const message = await fullMessage(JSON.parse(process.argv[1])); console.log(JSON.stringify({characters: message.content.length})); } catch(error) { console.error(error.stack); }`,
      JSON.stringify(data),
    ]);
    console.error(diagnostic.stdout, diagnostic.stderr);
  }
  assert.equal(operation.status, 'succeeded', `${action} ${operation.status}`);
  return operation.result;
}
const options = {
  fetcher: () => fetcher,
  storage,
  gatewayToken,
  pair: async (identity) => {
    pairCalls++;
    await job('pair', { identity });
  },
  fullMessage: async (mapping, messageId) =>
    (await job('full-message', { ...mapping, messageId })).message,
};
const gateway = new NativeGateway(options);
const identity = await gateway.identity();
let recreated;
const envPath = resolve(directory, 'docker.env');
await writeFile(
  envPath,
  Object.entries({
    BOOT_ID: bootId,
    HELPER_TOKEN: helperToken,
    GATEWAY_TOKEN: gatewayToken,
    EXPECTED_MANAGER_DEVICE_ID: identity.deviceId,
    EXPECTED_MANAGER_PUBLIC_KEY: identity.publicKey,
    R2_ORIGIN: process.env.OPENCLAW_RECOVERY_CREDENTIALS
      ? 'https://65cabd080cdf7a36f76d0e884752c249.r2.cloudflarestorage.com'
      : 'https://integration.r2.cloudflarestorage.com',
    NODE_COMPILE_CACHE: '/var/lib/messenger-helper/node-cache',
  })
    .map(([key, value]) => `${key}=${value}`)
    .join('\n'),
  { mode: 0o600 },
);
const started = Date.now();
try {
  await exec('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--env-file',
    envPath,
    '-p',
    '127.0.0.1::8787',
    '-p',
    '127.0.0.1::18789',
    image,
  ]);
  const port = async (internal) =>
    Number(
      (await exec('docker', ['port', name, internal])).stdout
        .trim()
        .split(':')
        .at(-1),
    );
  helperOrigin = `http://127.0.0.1:${await port('8787')}`;
  gatewayOrigin = `http://127.0.0.1:${await port('18789')}`;
  let healthy;
  for (let i = 0; i < 100; i++) {
    try {
      healthy = await request('/health');
      break;
    } catch {
      await delay(100);
    }
  }
  assert.equal(healthy?.gatewayState, 'stopped');
  await job('initialize', { identity });
  await job('start', {});
  gateway.start();
  await gateway.waitReady(240000);
  gateway.dispatch(true);
  assert.equal(pairCalls, 1);
  assert.ok(values.get('deviceToken')?.token);
  const mapping = { agentId: 'main', sessionKey: 'agent:main:main' };
  await gateway.request('sessions.create', {
    agentId: 'main',
    key: mapping.sessionKey,
    idempotencyKey: randomUUID(),
    permissionMode: 'workspace',
  });
  const pagination = await verifyNativePagination(gateway, mapping);
  const longReply = 'A complete long reply. '.repeat(110000);
  await gateway.request('chat.inject', { ...mapping, message: longReply });
  const history = await gateway.history(mapping);
  assert.equal(history.messages.at(-1)?.text, longReply);
  await gateway.stop();
  // Existing local engine and durable DO identity/token survive an adapter restart.
  recreated = new NativeGateway({
    ...options,
    gatewayToken: 'unused-shared-token-after-pairing',
  });
  assert.deepEqual(await recreated.identity(), identity);
  recreated.start();
  await recreated.waitReady(60000);
  recreated.dispatch(true);
  assert.equal(pairCalls, 1);
  assert.equal(
    (await recreated.history(mapping)).messages.at(-1)?.text,
    longReply,
  );
  let recovery = {};
  if (process.env.OPENCLAW_RECOVERY_CREDENTIALS) {
    const { verifyNativeRecovery } =
      await import('./native-recovery.integration.mjs');
    recovery = await verifyNativeRecovery({
      exec,
      job,
      gateway: recreated,
      mapping,
      identity,
      app,
      directory,
      helperToken,
      gatewayToken,
      image,
      request,
      containerName: () => name,
      switchContainer: (next) => {
        name = next.name;
        bootId = next.bootId;
        helperOrigin = next.helperOrigin;
        gatewayOrigin = next.gatewayOrigin;
        containerNames.add(name);
      },
      createGateway: (token) =>
        new NativeGateway({ ...options, gatewayToken: token }),
    });
  }
  // An authenticated helper request cannot approve a different signing identity.
  const wrong = new NativeGateway({
    ...options,
    storage: {
      get: async () => undefined,
      put: async () => {},
      delete: async () => false,
    },
  });
  let rejected = false;
  try {
    await job('pair', { identity: await wrong.identity() });
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
  wrong.start();
  await assert.rejects(wrong.waitReady(4000));
  assert.equal(wrong.ready, false);
  await wrong.stop();
  await recreated.stop();
  const pairCallsBeforeLocalRestart = pairCalls;
  await job('stop', {});
  assert.equal((await request('/health')).gatewayState, 'stopped');
  await job('start', {});
  recreated.start();
  await recreated.waitReady(60000);
  recreated.dispatch(true);
  assert.equal(pairCalls, pairCallsBeforeLocalRestart);
  assert.equal(
    (await recreated.history(mapping)).messages.at(-1)?.text,
    longReply,
  );
  await recreated.stop();
  await job('stop', {});
  assert.equal((await request('/health')).gatewayState, 'stopped');
  console.log(
    JSON.stringify({
      ...recovery,
      ...pagination,
      nativeSdkAuthentication: true,
      nativeStopRestartPreservesState: true,
      exactIdentityPairing: true,
      wrongIdentityRejected: true,
      durableTokenReused: true,
      helperOnlyBoot: true,
      completeReplyCharacters: longReply.length,
      helperFallbackVerified: true,
      upgrades,
      elapsedMs: Date.now() - started,
    }),
  );
} finally {
  await gateway.stop();
  await recreated?.stop();
  for (const container of containerNames)
    await exec('docker', ['rm', '-f', container]).catch(() => {});
  await rm(envPath, { force: true });
}
