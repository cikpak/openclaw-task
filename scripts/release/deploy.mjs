import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, run, verify, workerNames } from './common.mjs';

const directory = resolve(process.argv[2] ?? '');
const selection = process.argv[3];
const initialContainer = process.argv[4] === '--initial-container';
if (
  !directory ||
  !['backend-bootstrap', 'manager', 'backend', 'pages'].includes(selection) ||
  (process.argv[4] && (!initialContainer || selection !== 'manager')) ||
  process.argv.length > 5
)
  throw new Error(
    'Usage: release:deploy <artifact-directory> <backend-bootstrap|manager|backend|pages> [--initial-container (manager only)]',
  );
const manifest = await verify(directory);
const env = { ...process.env, CI: 'true' };
if (selection === 'pages') {
  await run(
    'pnpm',
    [
      'dlx',
      'wrangler@4.136.0',
      'pages',
      'deploy',
      resolve(directory, 'pages'),
      '--project-name',
      'openclaw-messenger',
      '--branch',
      'master',
      '--commit-hash',
      manifest.commit,
    ],
    { cwd: directory, env },
  );
} else {
  const secretsFile =
    selection === 'manager'
      ? process.env.RELEASE_MANAGER_SECRETS_FILE
      : process.env.RELEASE_BACKEND_SECRETS_FILE;
  if (!secretsFile)
    throw new Error('Select the private deployment secret bundle');
  const secrets = JSON.parse(await readFile(secretsFile, 'utf8'));
  if (selection === 'manager') {
    const names = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].filter(
      (name) => !!secrets[name],
    );
    if (JSON.stringify(names) !== JSON.stringify(manifest.providerSecretNames))
      throw new Error('Provider secret names differ from release');
    await run('docker', [
      'load',
      '--input',
      resolve(directory, 'engine-image.tar'),
    ]);
    const imageId = execFileSync(
      'docker',
      ['image', 'inspect', '--format', '{{.Id}}', manifest.image.pinned],
      { encoding: 'utf8' },
    ).trim();
    if (imageId !== manifest.image.id)
      throw new Error('Container image digest mismatch');
    await run('docker', ['tag', imageId, manifest.image.reference]);
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'openclaw-release-'));
  try {
    const output = resolve(temporary, '.cloudflare/output/v0');
    await cp(resolve(directory, selection), output, { recursive: true });
    // Prebuilt deploy reads only this pinned output, no live checkout/build configuration.
    const cf = resolve(root, 'apps/cloudflare/node_modules/cf/bin/cf');
    await run(
      process.execPath,
      [
        cf,
        'deploy',
        '--prebuilt',
        '--mode',
        selection,
        '--worker',
        workerNames[selection],
        '--containers-rollout',
        initialContainer ? 'immediate' : 'none',
        '--secrets-file',
        resolve(secretsFile),
      ],
      { cwd: temporary, env },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
