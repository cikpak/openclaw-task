/** Build the production helper from this checkout; every probe uses its immutable ID. */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const directory = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'messenger-engine-check-'));
const tag = `messenger-engine-check:${randomUUID()}`;
async function run(command, args, env = process.env) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
try {
  await run('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '--iidfile',
    resolve(temporary, 'image-id'),
    '--tag',
    tag,
    '--file',
    'container/Dockerfile',
    'container',
  ]);
  const image = (await readFile(resolve(temporary, 'image-id'), 'utf8')).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('Invalid built helper image identity');
  const env = { ...process.env, OPENCLAW_TEST_IMAGE: image };
  for (const args of [
    ['test/helper/files.mjs'],
    ['--test', 'test/helper/directories.test.mjs'],
    ['--test', 'test/helper/handoff.test.mjs'],
    ['--test', 'test/helper/pdf.test.mjs'],
    ['--test', 'test/helper/readback.test.mjs'],
    [
      '--test',
      'test/helper/native-owner.test.mjs',
      'test/helper/native-owner-races.test.mjs',
      'test/helper/native-owner-install.test.mjs',
    ],
    ['test/helper/docker.mjs'],
    ['test/native-gateway.integration.mjs'],
    ['test/native-followup.integration.mjs'],
  ])
    await run(process.execPath, args, env);
  console.info(
    JSON.stringify({
      passed: true,
      productionHelperImage: image,
      checks: [
        'files',
        'directories',
        'handoff',
        'pdf',
        'readback',
        'preservation',
        'native-sdk',
        'native-owner-patch',
        'native-followup',
      ],
    }),
  );
} finally {
  // Remove only our unique tag; never prune shared images or unrelated containers.
  try {
    execFileSync('docker', ['image', 'rm', '--no-prune', tag], {
      stdio: 'ignore',
    });
  } catch {
    /* Failed build may not have created it. */
  }
  await rm(temporary, { recursive: true, force: true });
}
