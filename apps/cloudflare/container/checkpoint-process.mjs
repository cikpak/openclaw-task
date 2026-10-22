import { spawn } from 'node:child_process';
import { getHeapStatistics } from 'node:v8';
import { setTimeout as delay } from 'node:timers/promises';
import { members } from './processes.mjs';
export function checkpoint(action, stage, input, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const args = [
      new URL('./checkpoint.py', import.meta.url).pathname,
      action,
      stage,
    ];
    if (action === 'capture')
      args.push(typeof input === 'string' ? input : input.checkpointId);
    const child = spawn('python3', args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    let bytes = 0,
      killed = false;
    const stop = () => {
      killed = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* Process may already have exited. */
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 30 * 60000);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > Math.floor(getHeapStatistics().heap_size_limit / 8)) stop();
      else chunks.push(chunk);
    });
    child.once('error', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      reject(new Error('Checkpoint process unavailable'));
    });
    child.once('close', async (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      if (killed && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Process may already have exited. */
        }
        while ((await members(child.pid)).length) await delay(20);
      }
      if (code !== 0 || killed)
        return reject(new Error('Checkpoint operation failed'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid checkpoint response'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(
      action === 'restore' ||
        (action === 'capture' && typeof input === 'object')
        ? JSON.stringify(input)
        : '',
    );
  });
}
