import { readdir, readFile } from 'node:fs/promises';
const gone = (error) => ['ENOENT', 'ESRCH'].includes(error?.code);
/** Private metadata only: never read commands, environment or descriptor targets. */
export async function writerSnapshot() {
  const rows = [];
  const deadline = Date.now() + 1000;
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/u.test(name) || Number(name) === process.pid) continue;
    if (Date.now() >= deadline || rows.length >= 4096)
      throw new Error('Writer census incomplete');
    try {
      const [stat, status] = await Promise.all([
        readFile(`/proc/${name}/stat`, 'utf8'),
        readFile(`/proc/${name}/status`, 'utf8'),
      ]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') continue;
      if (
        !Number.isSafeInteger(Number(fields[1])) ||
        Number(fields[1]) < 0 ||
        !Number.isSafeInteger(Number(fields[2])) ||
        Number(fields[2]) <= 0 ||
        !/^[0-9]+$/u.test(fields[19] ?? '')
      )
        throw new Error('Writer census incomplete');
      const uids = /^Uid:\s+(.+)$/mu
        .exec(status)?.[1]
        .trim()
        .split(/\s+/u)
        .map(Number);
      if (uids?.length !== 4 || uids.some((uid) => !Number.isSafeInteger(uid)))
        throw new Error('Writer census incomplete');
      rows.push({
        pid: Number(name),
        parent: Number(fields[1]),
        group: Number(fields[2]),
        start: fields[19],
        uid1000: uids.includes(1000),
        nativeUid: uids.every((uid) => uid === 1000),
      });
    } catch (error) {
      if (!gone(error)) throw error;
    }
  }
  return rows;
}
/** Relations describe observations only, never authority to signal a process. */
export function writerEvidence(target, before, after, helperPid = process.pid) {
  const descendants = new Set();
  const root = before?.find(
    (row) => row.pid === target.pid && row.start === target.start,
  );
  if (root) {
    descendants.add(root.pid);
    let size;
    do {
      size = descendants.size;
      for (const row of before)
        if (descendants.has(row.parent)) descendants.add(row.pid);
    } while (descendants.size !== size);
  }
  const remaining = after?.filter((row) => row.uid1000) ?? [];
  const proven = remaining.filter(
    (row) =>
      descendants.has(row.pid) &&
      before.some(
        (prior) =>
          prior.pid === row.pid && prior.start === row.start && prior.uid1000,
      ),
  );
  return {
    beforeAvailable: Array.isArray(before),
    afterAvailable: Array.isArray(after),
    remainingUid1000: remaining.length,
    sameGatewayGroup: remaining.filter((row) => row.group === target.group)
      .length,
    provenDescendants: proven.length,
    unassociatedUid1000: remaining.length - proven.length,
    parentIsHelper: remaining.filter((row) => row.parent === helperPid).length,
  };
}
