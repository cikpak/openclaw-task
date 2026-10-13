import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Own a fresh test-only project. Never attach acceptance to application volumes.
const project = `messenger-acceptance-${randomUUID().slice(0, 8)}`;
process.env.ACCEPTANCE_PROJECT = project;
process.env.ACCEPTANCE_PORT ??= '18080';
const origin = `http://localhost:${process.env.ACCEPTANCE_PORT}`;
process.env.ACCEPTANCE_ORIGIN = origin;
const compose = [
  'compose',
  '--env-file',
  '.context/test.env',
  '-p',
  project,
  '-f',
  'compose.yaml',
  '-f',
  'compose.test.yaml',
];
async function run(command, args, capture = false, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnv },
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let output = '';
    if (capture)
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
    // Captured Compose configuration can contain synthetic secrets: never print it.
    if (capture) child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args[0]} failed with exit ${code}`));
    });
  });
}
await mkdir('.context', { recursive: true });
try {
  await access('.context/test.env');
  await access('.context/test-password.txt');
} catch {
  await run('pnpm', ['setup:env', '--test']);
}
const configured = JSON.parse(
  await run('docker', [...compose, 'config', '--format', 'json'], true),
);
assert.deepEqual(Object.keys(configured.services).sort(), [
  'backend',
  'frontend',
  'openclaw',
]);
assert.equal(configured.services.backend.ports, undefined);
assert.equal(configured.services.openclaw.ports, undefined);
assert.ok(
  configured.networks.web.internal,
  'Frontend/backend network must be private',
);
assert.deepEqual(Object.keys(configured.services.frontend.networks).sort(), [
  'edge',
  'web',
]);
assert.deepEqual(Object.keys(configured.services.backend.networks).sort(), [
  'gateway',
  'web',
]);
assert.deepEqual(Object.keys(configured.services.openclaw.networks), [
  'gateway',
]);
assert.ok(
  configured.services.backend.volumes.some(
    (volume) => volume.target === '/data' && volume.type === 'volume',
  ),
);
assert.ok(
  configured.services.openclaw.volumes.some(
    (volume) =>
      volume.target === '/home/node/.openclaw' && volume.type === 'volume',
  ),
);
assert.ok(configured.services.openclaw.healthcheck);
assert.ok(configured.services.backend.healthcheck);
let invalidRejected = false;
try {
  await run('docker', [...compose, 'config', '--quiet'], true, {
    GATEWAY_TOKEN: '',
  });
} catch {
  invalidRejected = true;
}
assert.ok(invalidRejected, 'Missing Gateway token must reject Compose startup');
try {
  console.info(
    `Fresh Compose acceptance: ${project}, ${origin}; local deterministic provider only.`,
  );
  await run('docker', [...compose, 'up', '--build', '-d']);
  let ready = false;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      if (
        (await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(3000) }))
          .ok
      ) {
        ready = true;
        break;
      }
    } catch {
      /* The frontend starts before authenticated Gateway readiness. */
    }
    await delay(2000);
  }
  assert.ok(
    ready,
    'Automatic device pairing and reconciliation must reach readiness',
  );
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  await run('pnpm', ['test:gateway']);
  await run('pnpm', ['test:media']);
  await run('pnpm', ['test:e2e', '--max-failures=1']);
  await run('pnpm', ['test:capacity']);
  console.info(
    'PASS fresh Compose, network/persistence/configuration checks, pinned Gateway/media contracts, desktop/mobile journeys and isolated restarts. No live provider check claimed.',
  );
} finally {
  // Keep only explicit structural diagnostics; ordinary logs can contain chat data.
  try {
    const statuses = await run(
      'docker',
      [...compose, 'ps', '--all', '--format', 'json'],
      true,
    );
    for (const line of statuses.split('\n').filter(Boolean)) {
      const status = JSON.parse(line);
      if (['backend', 'openclaw', 'frontend'].includes(status.Service))
        console.info(
          JSON.stringify({
            recoveryDiagnostic: true,
            phase: 'container',
            service: status.Service,
            state: [
              'running',
              'exited',
              'restarting',
              'created',
              'dead',
            ].includes(status.State)
              ? status.State
              : 'other',
            exitCode: Number.isSafeInteger(status.ExitCode)
              ? status.ExitCode
              : null,
          }),
        );
    }
    const logs = await run(
      'docker',
      [...compose, 'logs', '--no-log-prefix', '--no-color', 'backend'],
      true,
    );
    for (const line of logs.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const record = JSON.parse(line);
        if (record.recoveryDiagnostic === true)
          console.info(JSON.stringify(record));
      } catch {
        /* Ignore ordinary or incomplete log lines. */
      }
    }
  } catch {
    console.info(
      'Recovery diagnostics unavailable; preserving the original test outcome.',
    );
  }
  // Exact randomly generated project owns disposable synthetic test data only.
  if (process.env.ACCEPTANCE_KEEP === '1')
    console.info(
      `Retained synthetic project ${project} for diagnosis; use its exact Compose project name to clean up when finished.`,
    );
  else
    await run('docker', [...compose, 'down', '--volumes', '--remove-orphans']);
}
