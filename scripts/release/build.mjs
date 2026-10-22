import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { root, run, inventory, verify } from './common.mjs';

const output = resolve(process.argv[2] ?? '.context/releases/current');
const runtimeFile = process.env.RELEASE_RUNTIME_FILE;
const managerSecretsFile = process.env.RELEASE_MANAGER_SECRETS_FILE;
if (!runtimeFile || !managerSecretsFile)
  throw new Error(
    'Select RELEASE_RUNTIME_FILE and RELEASE_MANAGER_SECRETS_FILE privately',
  );
const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
const secrets = JSON.parse(await readFile(managerSecretsFile, 'utf8'));
for (const name of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])
  if (!secrets[name]) throw new Error(`Missing ${name}`);
const providerNames = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].filter(
  (name) => typeof secrets[name] === 'string' && secrets[name].length > 0,
);
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain'))
  throw new Error('Release requires a clean committed checkout');
const commit = git('rev-parse', 'HEAD');
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false, mode: 0o700 });
const env = {
  ...process.env,
  APP_ORIGIN: runtime.appOrigin,
  APP_USERNAME: runtime.username,
  DEFAULT_MODEL: runtime.defaultModel,
  DEPLOY_PROVIDER_SECRET_NAMES: providerNames.join(','),
};
// Only names select provider bindings. Build processes receive no supplied secret values.
for (const name of [
  ...providerNames,
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'APP_PASSWORD_HASH',
])
  delete env[name];
let image;
for (const mode of ['backend-bootstrap', 'manager', 'backend']) {
  await run(
    'pnpm',
    [
      '--filter',
      '@messenger/cloudflare',
      'exec',
      'cf',
      'build',
      '--mode',
      mode,
    ],
    { env },
  );
  await cp(
    resolve(root, 'apps/cloudflare/.cloudflare/output/v0'),
    resolve(output, mode),
    { recursive: true },
  );
  if (mode === 'manager') {
    const containerConfig = JSON.parse(
      await readFile(
        resolve(
          output,
          mode,
          'containers/openclaw-messenger-engine/container.config.json',
        ),
        'utf8',
      ),
    );
    const reference = containerConfig.images?.base?.localReference;
    if (!reference)
      throw new Error('Manager build did not produce a container image');
    const id = execFileSync(
      'docker',
      ['image', 'inspect', '--format', '{{.Id}}', reference],
      { encoding: 'utf8' },
    ).trim();
    const pinned = `openclaw-release:${commit}`;
    await run('docker', ['tag', id, pinned]);
    await run('docker', [
      'save',
      '--output',
      resolve(output, 'engine-image.tar'),
      pinned,
    ]);
    image = { id, reference, pinned };
  }
}
await run('pnpm', ['--filter', '@messenger/frontend', 'build'], { env });
await cp(resolve(root, 'apps/frontend/dist'), resolve(output, 'pages'), {
  recursive: true,
});
await cp(
  resolve(root, 'apps/frontend/functions'),
  resolve(output, 'pages-functions'),
  { recursive: true },
);
// Compile thin functions now; deployment must consume compiled bytes from this commit.
await run(
  'pnpm',
  [
    'dlx',
    'wrangler@4.136.0',
    'pages',
    'functions',
    'build',
    resolve(root, 'apps/frontend/functions'),
    '--outdir',
    resolve(output, 'pages/_worker.js'),
    '--build-output-directory',
    resolve(output, 'pages'),
  ],
  { env },
);
await cp(
  resolve(root, 'apps/cloudflare/migrations'),
  resolve(output, 'migrations'),
  { recursive: true },
);
await cp(
  resolve(root, 'apps/frontend/wrangler.jsonc'),
  resolve(output, 'wrangler.jsonc'),
);
execFileSync(
  'git',
  [
    'archive',
    '--format=tar',
    '--output',
    resolve(output, 'container-context.tar'),
    commit,
    'apps/cloudflare/container',
  ],
  { cwd: root },
);

if (git('rev-parse', 'HEAD') !== commit || git('status', '--porcelain'))
  throw new Error('Checkout changed during release build');
const manifest = {
  version: 1,
  commit,
  createdAt: new Date().toISOString(),
  providerSecretNames: providerNames,
  image,
  files: await inventory(output),
};
await writeFile(
  resolve(output, 'release.json'),
  JSON.stringify(manifest, null, 2),
);
await verify(output);
console.info(`Immutable release prepared at ${output} (${commit})`);
