import { gatewayEnvironment } from './gateway-environment.mjs';
import { spawn } from 'node:child_process';
import { verifyNoWriters } from './writers.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
export async function members(group) {
  const found = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === group && fields[0] !== 'Z')
        found.push(Number(name));
    } catch {
      /* Process may already have exited. */
    }
  }
  return found;
}
export function createSupervisor() {
  let gateway,
    group,
    state = 'stopped';
  return {
    status: () => state,
    async stopped() {
      if (
        gateway ||
        state !== 'stopped' ||
        (group && (await members(group)).length)
      )
        throw new Error('Gateway writers must be stopped');
      await verifyNoWriters();
    },
    async start(signal) {
      signal.throwIfAborted();
      if (gateway) return { gatewayState: state };
      if (group && (await members(group)).length)
        throw new Error('Gateway writers still active');
      await verifyNoWriters();
      const child = spawn(
        process.execPath,
        ['/app/openclaw.mjs', 'gateway', '--bind', 'lan', '--port', '18789'],
        {
          uid: 1000,
          gid: 1000,
          detached: true,
          stdio: 'ignore',
          env: gatewayEnvironment(),
        },
      );
      state = 'starting';
      gateway = child;
      group = child.pid;
      child.once('exit', () => {
        if (gateway === child) {
          gateway = undefined;
          state = 'exited';
          void members(child.pid).then((alive) => {
            if (group === child.pid)
              state = alive.length ? 'failed' : 'stopped';
          });
        }
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', () => {
          gateway = undefined;
          state = 'stopped';
          reject(new Error('Gateway spawn failed'));
        });
      });
      state = 'running';
      return { gatewayState: state, processSpawned: true };
    },
    async stop() {
      if (!group) {
        await verifyNoWriters();
        state = 'stopped';
        return { gatewayState: state, remainingWriters: 0 };
      }
      state = 'stopping';
      try {
        process.kill(-group, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      const deadline = Date.now() + 30000;
      while ((await members(group)).length && Date.now() < deadline)
        await delay(100);
      if ((await members(group)).length) {
        state = 'failed';
        throw new Error('Gateway did not stop gracefully');
      }
      gateway = undefined;
      group = undefined;
      state = 'stopped';
      await verifyNoWriters();
      return { gatewayState: state, remainingWriters: 0 };
    },
  };
}
