import assert from 'node:assert/strict';
/** Real processes in separate sessions, killed only by their exact owned test PIDs. */
export async function detachedWriters(docker, name, job) {
  for (const uid of [1000, 0]) {
    const writer = `import {openSync,writeSync} from 'node:fs';const fd=openSync('/recovery/workspace/detached-${uid}.txt','a');setInterval(()=>writeSync(fd,'preserve\\n'),100);`;
    const spawner = `import{spawn}from'node:child_process';const c=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(writer)}],{uid:${uid},gid:${uid},detached:true,stdio:'ignore'});c.unref();console.log(c.pid);`;
    const pid = Number(
      docker([
        'exec',
        name,
        'node',
        '--input-type=module',
        '-e',
        spawner,
      ]).trim(),
    );
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    try {
      // The child is no longer in the spawner/Gateway group. Source can be stable while it sleeps.
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal((await job('stop')).status, 'failed');
      assert.equal(
        (await job('capture', { checkpointId: `detached-${uid}` })).status,
        'failed',
      );
    } finally {
      docker(['exec', name, 'node', '-e', `process.kill(${pid},'SIGKILL')`]);
    }
    assert.equal((await job('stop')).status, 'succeeded');
    assert.equal((await job('inspect')).status, 'succeeded');
  }
}
