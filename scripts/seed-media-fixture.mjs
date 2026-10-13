import { execFileSync } from 'node:child_process';

export const IMAGE_FIXTURE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/** Preseeds only a newly-created deterministic-provider agent's workspace, never application or user data. */
export function seedWorkspaceImage(chatId) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      chatId,
    )
  )
    throw new Error('A test chat UUID is required');
  const project =
    process.env.ACCEPTANCE_PROJECT ?? 'messenger-final-acceptance';
  if (!/^messenger-[a-z0-9-]*(?:acceptance|test)[a-z0-9-]*$/.test(project))
    throw new Error('Only a separate test Compose project may be seeded');
  const script = `
    import { readFile, realpath, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const [agentId, base64] = process.argv.slice(1);
    const config = JSON.parse(await readFile('/home/node/.openclaw/openclaw.json', 'utf8'));
    if (config.models?.providers?.mock?.baseUrl !== 'http://127.0.0.1:18889/v1') throw new Error('Deterministic test provider is required');
    const workspace = config.agents?.entries?.[agentId]?.workspace;
    if (typeof workspace !== 'string') throw new Error('Exact owned test agent workspace is required');
    const actual = await realpath(workspace);
    if (actual !== join('/home/node/.openclaw/workspace', agentId)) throw new Error('Unexpected test agent workspace');
    await writeFile(join(actual, 'artifact-fixture.png'), Buffer.from(base64, 'base64'), { flag: 'wx', mode: 0o600 });
  `;
  execFileSync(
    'docker',
    [
      'compose',
      '-p',
      project,
      '--env-file',
      process.env.ACCEPTANCE_ENV_FILE ?? '.context/test.env',
      '-f',
      'compose.yaml',
      '-f',
      'compose.test.yaml',
      'exec',
      '-T',
      'openclaw',
      'node',
      '--input-type=module',
      '-e',
      script,
      `messenger-${chatId}`,
      IMAGE_FIXTURE_BYTES.toString('base64'),
    ],
    { stdio: 'pipe', timeout: 30_000 },
  );
}
