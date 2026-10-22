import { readdir, readFile, readlink } from 'node:fs/promises';
import { root } from './environment.mjs';
const gone = (error) => error.code === 'ENOENT' || error.code === 'ESRCH';
/** Detached process groups can outlive Gateway. Prove all possible engine writers stopped. */
export async function verifyNoWriters() {
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const directory = `/proc/${name}`;
    try {
      const stat = await readFile(`${directory}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z') continue;
      const status = await readFile(`${directory}/status`, 'utf8');
      const uids = /^Uid:\s+(.+)$/m
        .exec(status)?.[1]
        .trim()
        .split(/\s+/)
        .map(Number);
      if (!uids) throw new Error('Cannot verify process ownership');
      if (uids.includes(1000))
        throw new Error('Detached engine writer remains');
      for (const fd of await readdir(`${directory}/fd`)) {
        try {
          const target = (await readlink(`${directory}/fd/${fd}`)).replace(
            / \(deleted\)$/,
            '',
          );
          if (target !== root && !target.startsWith(`${root}/`)) continue;
          const info = await readFile(`${directory}/fdinfo/${fd}`, 'utf8');
          const flags = /^flags:\s+([0-7]+)$/m.exec(info)?.[1];
          if (!flags) throw new Error('Cannot verify recovery descriptor');
          if (parseInt(flags, 8) & 3)
            throw new Error('Recovery writer descriptor remains');
        } catch (error) {
          if (!gone(error)) throw error;
        }
      }
    } catch (error) {
      if (!gone(error)) throw error;
    }
  }
}
