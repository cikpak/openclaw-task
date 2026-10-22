import { cleanupOwnedRuntime } from './acceptance/cleanup.mjs';
import { verifyFallbackCoverage } from './acceptance/fallback-coverage.mjs';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { scrypt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { run } from './acceptance/run.mjs';
const id = randomBytes(6).toString('hex');
const stateDir = `${process.cwd()}/.context/acceptance-${id}`;
await mkdir(stateDir, { recursive: true, mode: 0o700 });
async function port() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const result = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return result;
}
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16).toString('hex');
const key = await promisify(scrypt)(password, Buffer.from(salt, 'hex'), 64);
const envFile = `${stateDir}/test.env`,
  passwordFile = `${stateDir}/password.txt`;
await writeFile(passwordFile, password, { mode: 0o600 });
await writeFile(
  envFile,
  `APP_USERNAME=admin\nAPP_PASSWORD_HASH='scrypt$${salt}$${key.toString('hex')}'\nDEFAULT_MODEL=mock/test-model\nENGINE_IDLE_SECONDS=60\n`,
  { mode: 0o600 },
);
const frontendPort = await port();
let harnessPort = await port();
while (harnessPort === frontendPort) harnessPort = await port();
const env = {
  ...process.env,
  ACCEPTANCE_VERIFY_FALLBACK: '1',
  MESSENGER_ENV_FILE: envFile,
  APP_USERNAME: 'admin',
  DEFAULT_MODEL: 'mock/test-model',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  DEPLOY_PROVIDER_SECRET_NAMES: '',
  CLOUDFLARE_WORKSPACE_ID: id,
  CLOUDFLARE_STATE_DIR: stateDir,
  FRONTEND_PORT: String(frontendPort),
  CLOUDFLARE_PORT: String(harnessPort),
  ACCEPTANCE_PROJECT: `messenger-acceptance-${id}`,
  ACCEPTANCE_ORIGIN: `http://127.0.0.1:${frontendPort}`,
  ACCEPTANCE_HARNESS_ORIGIN: `http://127.0.0.1:${harnessPort}`,
  ACCEPTANCE_PASSWORD_FILE: passwordFile,
  ACCEPTANCE_RUNTIME_FILE: `${stateDir}/runtime.json`,
};
const execute = (command, args) =>
  promisify(execFile)(command, args, { timeout: 15000, killSignal: 'SIGKILL' });
const { stdout: existingIds } = await execute('docker', ['ps', '-q']);
const cleanupEvidence = {
  preexistingContainerIds: existingIds.trim().split(/\s+/u).filter(Boolean),
};
const runner = spawn('node', ['scripts/dev-cloudflare.mjs', '--acceptance'], {
  env,
  stdio: 'inherit',
});
let stage = 'startup';
let executionError;
let cleanupError;
try {
  let ready = false;
  for (let attempt = 0; attempt < 900; attempt++) {
    if (runner.exitCode !== null)
      throw new Error('Local Cloudflare harness exited before readiness');
    try {
      const runtime = JSON.parse(
        await readFile(env.ACCEPTANCE_RUNTIME_FILE, 'utf8'),
      );
      ready = runtime.mode === 'acceptance';
    } catch {
      /* First Docker build can take minutes. */
    }
    if (ready) break;
    await delay(1000);
  }
  assert.ok(ready, 'Real Cloudflare harness must reach readiness');
  for (const script of [
    'gateway-acceptance',
    'media-acceptance',
    'lifecycle-acceptance',
  ]) {
    stage = script;
    await run('node', [`scripts/${script}.mjs`], env);
  }
  stage = 'browser';
  await run('pnpm', ['test:e2e', '--max-failures=1'], env);
  stage = 'browser-aftercase-coverage';
  await verifyFallbackCoverage(env);
  stage = 'capacity';
  await run('node', ['scripts/capacity-acceptance.mjs'], env);
  console.info(
    'PASS actual local Cloudflare D1/DO/R2, private pinned native engine, deterministic-provider execution, recovery and desktop/mobile acceptance. No production-provider pass claimed.',
  );
} catch (error) {
  executionError = error;
  await run('node', ['scripts/acceptance/failure.mjs'], {
    ...env,
    ACCEPTANCE_FAILED_STAGE: stage,
  }).catch(() => undefined);
} finally {
  try {
    await cleanupOwnedRuntime(
      runner,
      env,
      cleanupEvidence.preexistingContainerIds,
      '.context/acceptance-cleanup-final.json',
    );
  } catch (error) {
    cleanupError = error;
  }
  // The exact randomly named state directory is retained for safe structural diagnosis.
  console.info(`Acceptance state: ${stateDir}`);
}

if (cleanupError)
  throw new AggregateError(
    [...(executionError ? [executionError] : []), cleanupError],
    'Acceptance execution or exact cleanup failed',
  );
if (executionError) throw executionError;
