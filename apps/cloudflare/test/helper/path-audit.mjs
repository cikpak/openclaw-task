import assert from 'node:assert/strict';
/** Existing workspace symlinks cannot redirect meaningful data into excluded temp/cache trees. */
export async function excludedWorkspace(docker, name, job) {
  const setup = `import{readFileSync,writeFileSync,mkdirSync,symlinkSync}from'node:fs';const p=process.env.OPENCLAW_CONFIG_PATH,raw=readFileSync(p);writeFileSync('/var/lib/messenger-helper/test-config',raw);const c=JSON.parse(raw);mkdirSync('/recovery/tmp/excluded-workspace',{recursive:true});symlinkSync('/recovery/tmp/excluded-workspace','/recovery/workspace-alias');c.agents.defaults.workspace='/recovery/workspace-alias';c.agents.entries.main.workspace='/recovery/workspace-alias';writeFileSync(p,JSON.stringify(c));`;
  docker(['exec', name, 'node', '--input-type=module', '-e', setup]);
  try {
    assert.equal((await job('inspect')).status, 'failed');
    assert.equal((await job('start')).status, 'failed');
  } finally {
    docker([
      'exec',
      name,
      'node',
      '--input-type=module',
      '-e',
      `import{copyFileSync,unlinkSync}from'node:fs';copyFileSync('/var/lib/messenger-helper/test-config',process.env.OPENCLAW_CONFIG_PATH);unlinkSync('/recovery/workspace-alias');unlinkSync('/var/lib/messenger-helper/test-config');`,
    ]);
  }
  assert.equal((await job('inspect')).status, 'succeeded');
}
