import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

export const root = resolve(import.meta.dirname, '../..');
export const workerNames = {
  'backend-bootstrap': 'openclaw-messenger-backend',
  manager: 'openclaw-messenger-manager',
  backend: 'openclaw-messenger-backend',
};
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
export async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function inventory(directory) {
  const files = {};
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = resolve(path, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('Release symlinks are forbidden');
      if (entry.isDirectory()) await walk(full);
      else if (entry.name !== 'release.json')
        files[relative(directory, full)] = {
          sha256: await digest(full),
          bytes: (await stat(full)).size,
        };
    }
  }
  await walk(directory);
  return files;
}
export async function verify(directory) {
  const manifest = JSON.parse(
    await readFile(resolve(directory, 'release.json'), 'utf8'),
  );
  if (manifest.version !== 1 || !/^[a-f0-9]{40}$/.test(manifest.commit))
    throw new Error('Invalid release manifest');
  const actual = await inventory(directory);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error('Release artifact checksum mismatch');
  if (!manifest.image || !/^sha256:[a-f0-9]{64}$/.test(manifest.image.id))
    throw new Error('Missing immutable engine image');
  if (
    !actual['engine-image.tar'] ||
    !actual['container-context.tar'] ||
    !actual['pages/_worker.js/index.js'] ||
    !actual['pages/_routes.json']
  )
    throw new Error('Release is incomplete');
  const routes = JSON.parse(
    await readFile(resolve(directory, 'pages/_routes.json'), 'utf8'),
  );
  for (const route of [
    '/api',
    '/api/*',
    '/ws/*',
    '/downloads/*',
    '/internal/*',
  ])
    if (!routes.include.includes(route))
      throw new Error('Incomplete Pages routing');
  const containerRoot = resolve(directory, 'manager/containers');
  if (
    JSON.stringify(await readdir(containerRoot)) !==
    JSON.stringify(['openclaw-messenger-engine'])
  )
    throw new Error('Unexpected engine artifact');
  const container = JSON.parse(
    await readFile(
      resolve(containerRoot, 'openclaw-messenger-engine/container.config.json'),
      'utf8',
    ),
  );
  if (
    container.name !== 'openclaw-messenger-engine' ||
    container.images?.base?.localReference !== manifest.image.reference ||
    Object.keys(container.images).length !== 1
  )
    throw new Error('Engine image reference mismatch');
  for (const file of Object.keys(actual)) {
    if (/acceptance|fixture|local-backend/.test(file))
      throw new Error('Test artifact is forbidden');
    if (/\.(?:js|json|jsonc)$/.test(file)) {
      const text = await readFile(resolve(directory, file), 'utf8');
      if (
        /__acceptance|CLOUDFLARE_ACCEPTANCE|openclaw-local-|localhost:18889/.test(
          text,
        )
      )
        throw new Error('Test configuration is forbidden');
    }
  }
  for (const [mode, worker] of Object.entries(workerNames)) {
    const config = JSON.parse(
      await readFile(resolve(directory, mode, 'config.json'), 'utf8'),
    );
    if (config.buildContext.mode !== mode)
      throw new Error('Release mode mismatch');
    const workerConfig = JSON.parse(
      await readFile(
        resolve(directory, mode, 'workers/default/worker.config.json'),
        'utf8',
      ),
    );
    if (
      workerConfig.name !== worker ||
      workerConfig.workersDev !== false ||
      workerConfig.previewUrls !== false
    )
      throw new Error('Unexpected public Worker configuration');
    if (
      workerConfig.env.LOCAL_R2_EMULATOR ||
      JSON.stringify(workerConfig).includes('openclaw-local-')
    )
      throw new Error('Local configuration is not deployable');
    if (
      workerConfig.observability?.logs?.invocationLogs !== false ||
      workerConfig.observability?.traces?.enabled !== false ||
      workerConfig.observability?.redactQueryString !== true
    )
      throw new Error('Unsafe Worker observability');
    if (mode === 'manager') {
      const names = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].filter(
        (name) => !!workerConfig.env[name],
      );
      if (
        JSON.stringify(names) !== JSON.stringify(manifest.providerSecretNames)
      )
        throw new Error('Provider declaration mismatch');
    }
    if (mode === 'backend-bootstrap' && workerConfig.env.MANAGER)
      throw new Error('Bootstrap reverse binding forbidden');
  }
  return manifest;
}
