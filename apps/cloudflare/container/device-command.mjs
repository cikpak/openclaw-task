import { gatewayEnvironment } from './gateway-environment.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { members } from './processes.mjs';
export function command(args, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const chunks = [];
    let bytes = 0,
      failed = false;
    const child = spawn(
      process.execPath,
      ['/app/openclaw.mjs', 'devices', ...args, '--json'],
      {
        env: gatewayEnvironment(),
        uid: 1000,
        gid: 1000,
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const stop = () => {
      failed = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Process already exited. */
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 90000);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 262144) stop();
      else chunks.push(chunk);
    });
    child.once('error', () => {
      failed = true;
    });
    child.once('close', async (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      // CLI descendants can also touch trust files. Never settle while any writer remains.
      if (child.pid && (await members(child.pid)).length) {
        stop();
        while ((await members(child.pid)).length) await delay(20);
      }
      if (failed || code !== 0 || signal.aborted)
        return reject(new Error('Device command failed'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid device command response'));
      }
    });
  });
}
