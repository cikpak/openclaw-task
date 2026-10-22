import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { localEnvironment } from './local-environment.mjs';

const { runtime, env } = await localEnvironment();
await rm(`${runtime.stateDir}/runtime.json`, { force: true });
const mode = process.argv.includes('--acceptance')
  ? 'acceptance'
  : 'development';
if (mode === 'acceptance') env.CLOUDFLARE_ACCEPTANCE = '1';
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* Process already exited. */
    }
  }
  const escalation = setTimeout(() => {
    for (const child of children) {
      if (!child.pid) continue;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Group exited. */
      }
    }
    process.exit(code);
  }, 15_000);
  const settled = setInterval(() => {
    const live = children.some((child) => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!live) {
      clearInterval(settled);
      clearTimeout(escalation);
      process.exit(code);
    }
  }, 100);
}
function start(args) {
  const child = spawn('pnpm', args, { env, stdio: 'inherit', detached: true });
  children.push(child);
  child.once('error', () => stop(1));
  child.once('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
  return child;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop());
start([
  '--filter',
  '@messenger/cloudflare',
  'exec',
  'cf',
  'dev',
  '--mode',
  mode,
]);
start(['--filter', '@messenger/frontend', 'dev']);
for (let attempt = 0; attempt < 600 && !stopping; attempt++) {
  try {
    const [frontend, backend] = await Promise.all([
      fetch(runtime.frontendOrigin),
      fetch(`${runtime.harnessOrigin}/api/session`),
    ]);
    if (
      frontend.ok &&
      backend.ok &&
      (await backend.json()).authenticated === false
    ) {
      await writeFile(
        `${runtime.stateDir}/runtime.json`,
        JSON.stringify({ ...runtime, mode, pid: process.pid }, null, 2),
        { mode: 0o600 },
      );
      console.info(`Local application ready: ${runtime.frontendOrigin}`);
      break;
    }
  } catch {
    /* Startup may include a Docker image build. */
  }
  await wait(500);
  if (attempt === 599) {
    console.error('Local startup timed out.');
    stop(1);
  }
}
