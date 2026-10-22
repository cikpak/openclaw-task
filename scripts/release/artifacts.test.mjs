import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { inventory, verify, workerNames } from './common.mjs';

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'release-guard-'));
  const write = async (path, value) => {
    await mkdir(resolve(directory, path, '..'), { recursive: true });
    await writeFile(
      resolve(directory, path),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  const image = {
    id: `sha256:${'a'.repeat(64)}`,
    reference: 'cloudflare-build/proof:version',
    pinned: 'openclaw-release:proof',
  };
  for (const [mode, worker] of Object.entries(workerNames)) {
    await write(`${mode}/config.json`, { buildContext: { mode } });
    await write(`${mode}/workers/default/worker.config.json`, {
      name: worker,
      workersDev: false,
      previewUrls: false,
      env: {},
      observability: {
        logs: { invocationLogs: false },
        traces: { enabled: false },
        redactQueryString: true,
      },
    });
  }
  await write(
    'manager/containers/openclaw-messenger-engine/container.config.json',
    {
      name: 'openclaw-messenger-engine',
      images: { base: { localReference: image.reference } },
    },
  );
  for (const path of [
    'engine-image.tar',
    'container-context.tar',
    'pages/_worker.js/index.js',
  ])
    await write(path, 'immutable-test-content');
  await write('pages/_routes.json', {
    include: ['/api', '/api/*', '/ws/*', '/downloads/*', '/internal/*'],
  });
  const manifest = {
    version: 1,
    commit: 'b'.repeat(40),
    image,
    providerSecretNames: [],
    files: await inventory(directory),
  };
  await write('release.json', manifest);
  async function alter(path, change, refresh = true) {
    const value = JSON.parse(await readFile(resolve(directory, path), 'utf8'));
    change(value);
    await write(path, value);
    if (refresh) {
      manifest.files = await inventory(directory);
      await write('release.json', manifest);
    }
  }
  return { directory, write, alter, manifest };
}
for (const [name, mutate, message] of [
  [
    'modified bytes',
    (f) => f.write('pages/_worker.js/index.js', 'changed'),
    /checksum/,
  ],
  [
    'wrong mode',
    (f) =>
      f.alter('manager/config.json', (v) => {
        v.buildContext.mode = 'acceptance';
      }),
    /mode/,
  ],
  [
    'local binding',
    (f) =>
      f.alter('manager/workers/default/worker.config.json', (v) => {
        v.env.LOCAL_R2_EMULATOR = { value: '1' };
      }),
    /Local/,
  ],
  [
    'bootstrap reverse binding',
    (f) =>
      f.alter('backend-bootstrap/workers/default/worker.config.json', (v) => {
        v.env.MANAGER = {};
      }),
    /Bootstrap/,
  ],
  [
    'ambient provider declaration',
    (f) =>
      f.alter('manager/workers/default/worker.config.json', (v) => {
        v.env.OPENAI_API_KEY = {};
      }),
    /Provider/,
  ],
  [
    'request URL logging',
    (f) =>
      f.alter('manager/workers/default/worker.config.json', (v) => {
        v.observability.logs.invocationLogs = true;
      }),
    /observability/,
  ],
  [
    'fixture bytes',
    async (f) => {
      await f.write('pages/_worker.js/index.js', '__acceptance');
      f.manifest.files = await inventory(f.directory);
      await f.write('release.json', f.manifest);
    },
    /Test/,
  ],
])
  test(`release rejects ${name}`, async () => {
    const f = await fixture();
    try {
      await verify(f.directory);
      await mutate(f);
      await assert.rejects(verify(f.directory), message);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
