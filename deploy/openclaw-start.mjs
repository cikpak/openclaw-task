import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  initialOpenClawConfig,
  matchBackendRequest,
} from './bootstrap-policy.mjs';

const stateDir = process.env.OPENCLAW_STATE_DIR ?? '/home/node/.openclaw';
const configPath =
  process.env.OPENCLAW_CONFIG_PATH ?? join(stateDir, 'openclaw.json');
await mkdir(stateDir, { recursive: true, mode: 0o700 });
await mkdir(join(stateDir, 'workspace'), { recursive: true, mode: 0o700 });
await mkdir('/bootstrap', { recursive: true, mode: 0o755 });
try {
  await writeFile(
    configPath,
    JSON.stringify(
      initialOpenClawConfig(
        process.env.DEFAULT_MODEL ?? 'anthropic/claude-sonnet-4-5',
      ),
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}

const gateway = spawn(
  process.execPath,
  ['/app/openclaw.mjs', 'gateway', '--bind', 'lan', '--port', '18789'],
  { stdio: 'inherit' },
);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true;
    gateway.kill(signal);
  });
}
gateway.on('exit', (code, signal) => {
  stopping = true;
  process.exit(code ?? (signal ? 1 : 0));
});

async function devices(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['/app/openclaw.mjs', 'devices', ...args, '--json'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 20_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 1_048_576) child.kill('SIGTERM');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('Device CLI unavailable'));
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error('Invalid device CLI response'));
      }
    });
  });
}

async function bootstrap() {
  const deadline = Date.now() + 180_000;
  let fingerprintPublished = false;
  while (!stopping && Date.now() < deadline) {
    try {
      if (!fingerprintPublished) {
        const cert = new X509Certificate(
          await readFile(join(stateDir, 'gateway/tls/gateway-cert.pem')),
        );
        await writeFile(
          '/bootstrap/gateway-fingerprint.next',
          cert.fingerprint256.replaceAll(':', '').toLowerCase() + '\n',
          { mode: 0o644 },
        );
        await rename(
          '/bootstrap/gateway-fingerprint.next',
          '/bootstrap/gateway-fingerprint.txt',
        );
        fingerprintPublished = true;
      }
      const identity = JSON.parse(
        await readFile('/bootstrap/backend-identity.json', 'utf8'),
      );
      const list = await devices('list');
      if (
        list.paired?.some(
          (device) =>
            device.deviceId === identity.deviceId &&
            device.publicKey === identity.publicKey &&
            device.roles?.includes('operator') &&
            identity.scopes?.every((scope) =>
              (device.approvedScopes ?? device.scopes ?? []).includes(scope),
            ),
        )
      ) {
        console.info('Messenger backend device is paired.');
        return;
      }
      const request = list.pending?.find((candidate) =>
        matchBackendRequest(candidate, identity),
      );
      if (request) {
        await devices('approve', request.requestId);
        console.info('Approved the exact messenger backend device request.');
        return;
      }
    } catch {
      // Startup files and the local CLI become available asynchronously.
    }
    await delay(2000);
  }
  if (!stopping)
    console.error(
      'Backend device bootstrap timed out. Check backend readiness and public identity exchange.',
    );
}
void bootstrap();
