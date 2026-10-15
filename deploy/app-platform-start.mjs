import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseConfig } from '/messenger/apps/backend/dist/apps/backend/src/config.js';

const input = process.env;
const stateDir = '/home/node/.openclaw';
const workspaceDir = `${stateDir}/workspace`;
const children = [];
let stopping = false;

// Child-specific allowlists keep provider keys out of Caddy and the backend,
// and keep messenger login/session secrets out of Gateway's environment.
function environment(keys) {
  return Object.fromEntries(
    [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'LANG',
      'LC_ALL',
      'TZ',
      'TMPDIR',
      ...keys,
    ]
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
}

function signalGroups(signal) {
  for (const { pid } of children) {
    if (!pid) continue;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH')
        console.error('Unable to signal a demo process group.');
    }
  }
}

function runningGroups() {
  return children.some(({ pid }) => {
    if (!pid) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return error.code !== 'ESRCH';
    }
  });
}

async function shutdown(signal, exitCode) {
  if (stopping) return;
  stopping = true;
  signalGroups(signal);
  const deadline = Date.now() + 15_000;
  while (runningGroups() && Date.now() < deadline) await delay(100);
  // Kill groups even if their original leader exited before its descendants.
  signalGroups('SIGKILL');
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void shutdown(signal, 0));
}

function start(name, command, args, env, cwd) {
  if (stopping) return;
  const child = spawn(command, args, {
    cwd,
    env: { ...env, NODE_ENV: 'production' },
    stdio: 'inherit',
    detached: true,
  });
  children.push(child);
  child.once('error', () => {
    console.error(`${name} failed to start.`);
    void shutdown('SIGTERM', 1);
  });
  child.once('exit', () => {
    if (stopping) return;
    console.error(`${name} exited; stopping the demo container.`);
    void shutdown('SIGTERM', 1);
  });
}

try {
  const origin = new URL(input.APP_ORIGIN ?? input.APP_URL ?? '');
  if (origin.protocol !== 'https:' || origin.username || origin.password)
    throw new Error('APP_ORIGIN must be the public HTTPS origin.');
  const backendEnv = {
    ...environment([
      'APP_USERNAME',
      'APP_PASSWORD_HASH',
      'SESSION_KEY',
      'SESSION_LIFETIME_SECONDS',
      'GATEWAY_TOKEN',
    ]),
    HOST: '127.0.0.1',
    PORT: '3000',
    DATA_DIR: '/data',
    APP_ORIGIN: origin.origin,
    ALLOW_INSECURE_LOOPBACK: 'false',
    TRUST_PROXY_HOPS: '1',
    GATEWAY_URL: 'wss://127.0.0.1:18789',
    GATEWAY_TLS_FINGERPRINT_FILE: '/bootstrap/gateway-fingerprint.txt',
    GATEWAY_PUBLIC_IDENTITY_FILE: '/bootstrap/backend-identity.json',
    GATEWAY_WORKSPACE_DIR: workspaceDir,
  };
  parseConfig(backendEnv);
  await Promise.all(
    ['/data', '/bootstrap', workspaceDir].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  start(
    'OpenClaw',
    process.execPath,
    ['/messenger/openclaw-start.mjs'],
    {
      ...environment([
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'DEFAULT_MODEL',
        'GATEWAY_TOKEN',
      ]),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: `${stateDir}/openclaw.json`,
    },
    '/app',
  );
  start(
    'Backend',
    process.execPath,
    ['/messenger/apps/backend/dist/apps/backend/src/main.js'],
    backendEnv,
    '/messenger',
  );
  start(
    'Caddy',
    'caddy',
    ['run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
    environment([]),
    '/messenger',
  );
} catch (error) {
  // Errors generated here contain no environment values or upstream payloads.
  console.error(
    error instanceof TypeError
      ? 'APP_ORIGIN must be the public HTTPS origin.'
      : 'Unable to initialize the demo. Check APP_ORIGIN, APP_USERNAME, APP_PASSWORD_HASH, SESSION_KEY, GATEWAY_TOKEN, and writable runtime directories.',
  );
  await shutdown('SIGTERM', 1);
}
