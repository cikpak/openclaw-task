import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('loads root and behavior subpath exports in native Node without a TS resolver', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const root = await import('@messenger/contracts');
    const behavior = await import('@messenger/contracts/agent-behavior');
    if (root.normalizeAgentBehavior !== behavior.normalizeAgentBehavior) throw new Error('Exports disagree');
    console.log(JSON.stringify(root.normalizeAgentBehavior({})));
  `,
    ],
    {
      cwd: fileURLToPath(new URL('../apps/backend/', import.meta.url)),
      encoding: 'utf8',
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    customInstructions: '',
    responseStyle: 'default',
    personality: 'neutral',
  });
});
