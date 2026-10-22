// Real pinned-image helper authorization, ownership, symlink and streaming checks; no provider.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
const image = process.argv[2] ?? process.env.OPENCLAW_TEST_IMAGE;
if (!image)
  throw new Error(
    'Run pnpm test:engine or select OPENCLAW_TEST_IMAGE explicitly',
  );
const name = `messenger-files-${randomUUID().slice(0, 8)}`;
const token = randomBytes(32).toString('hex');
const key = randomBytes(32),
  publicKey = key.toString('base64url');
const identity = {
  deviceId: createHash('sha256').update(key).digest('hex'),
  publicKey,
  role: 'operator',
  scopes: ['operator.admin', 'operator.read', 'operator.write'],
};
const docker = (args) =>
  execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
let base;
const scope = { agentId: 'main', sessionKey: 'agent:main:main' };
async function request(path, data, auth = token) {
  return fetch(base + path, {
    method: data ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${auth}`,
      'content-type': 'application/json',
    },
    body: data ? JSON.stringify(data) : undefined,
  });
}
try {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '-p',
    '127.0.0.1::8787',
    '--env',
    `HELPER_TOKEN=${token}`,
    '--env',
    `GATEWAY_TOKEN=${randomBytes(32).toString('hex')}`,
    '--env',
    `EXPECTED_MANAGER_DEVICE_ID=${identity.deviceId}`,
    '--env',
    `EXPECTED_MANAGER_PUBLIC_KEY=${publicKey}`,
    '--env',
    'BOOT_ID=files-test',
    image,
  ]);
  base = `http://${docker(['port', name, '8787/tcp']).trim()}`;
  for (let i = 0; ; i++) {
    try {
      if ((await request('/health')).ok) break;
    } catch {
      /* boot */
    }
    if (i > 100) throw Error('Helper did not boot');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const job = await request('/jobs', {
    operationId: 'initialize',
    bootId: 'files-test',
    action: 'initialize',
    data: { identity },
  });
  assert.equal(job.status, 202);
  for (;;) {
    const state = await (await request('/jobs/initialize')).json();
    if (state.status !== 'running') {
      assert.equal(state.status, 'succeeded');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  docker([
    'exec',
    name,
    'python3',
    '-c',
    `import pathlib,os
w=pathlib.Path('/recovery/workspace');d=w/'documents';d.mkdir()
(d/'report.txt').write_text('published content')
(d/'AGENTS.md').write_text('private instruction')
(d/'.secret').write_text('private secret')
(w/'private.txt').write_text('private content')
(d/'escape').symlink_to(w/'private.txt')
(d/'nested').symlink_to('/etc')
(d/'safe-link').symlink_to(d/'report.txt')
with (d/'large.bin').open('wb') as f:f.truncate(17*1024*1024)
os.mkfifo(d/'pipe')
`,
  ]);
  assert.equal(
    (
      await request(
        '/files/metadata',
        { ...scope, path: 'documents/report.txt' },
        'wrong',
      )
    ).status,
    401,
  );
  for (const path of [
    'documents/AGENTS.md',
    'documents/.secret',
    'private.txt',
    'documents/escape',
    'documents/nested/passwd',
    'documents/pipe',
    '/etc/passwd',
    '../private.txt',
  ]) {
    assert.equal(
      (await request('/files/metadata', { ...scope, path })).status,
      400,
      path,
    );
  }
  assert.equal(
    (
      await request('/files/metadata', {
        ...scope,
        sessionKey: 'agent:other:main',
        path: 'documents/report.txt',
      })
    ).status,
    400,
  );
  const metadata = await (
    await request('/files/metadata', { ...scope, path: 'documents/report.txt' })
  ).json();
  assert.equal(metadata.path, '/recovery/workspace/documents/report.txt');
  assert.equal(metadata.documentsRoot, '/recovery/workspace/documents');
  assert.equal(
    metadata.digest,
    createHash('sha256').update('published content').digest('hex'),
  );
  assert.equal(
    await (
      await request('/files/read', { ...scope, path: metadata.path })
    ).text(),
    'published content',
  );
  docker([
    'exec',
    name,
    'python3',
    '-c',
    "from pathlib import Path;p=Path('/recovery/workspace/documents/report.txt');p.unlink();p.symlink_to('/etc/passwd')",
  ]);
  assert.equal(
    (await request('/files/read', { ...scope, path: metadata.path })).status,
    400,
  );
  docker([
    'exec',
    name,
    'python3',
    '-c',
    `import pathlib,os
p=pathlib.Path('/recovery/workspace/documents/credential.txt');p.write_text('a'*65530+os.environ['GATEWAY_TOKEN']+'b'*100)
`,
  ]);
  assert.equal(
    (
      await request('/files/metadata', {
        ...scope,
        path: 'documents/credential.txt',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('/files/read', {
        ...scope,
        path: 'documents/credential.txt',
      })
    ).status,
    400,
  );
  assert.equal(
    docker([
      'exec',
      name,
      'stat',
      '-c',
      '%a:%U',
      '/var/lib/messenger-helper',
    ]).trim(),
    '700:root',
  );
  const inputPath = `/recovery/workspace/documents/.messenger-inputs/${createHash('sha256').update(scope.sessionKey).digest('hex')}/input123/sample.txt`;
  const issuedDeviceCredential =
    'issued-native-device-token-' + randomBytes(32).toString('hex');
  docker([
    'exec',
    name,
    'python3',
    '-c',
    `import pathlib,json
p=pathlib.Path(${JSON.stringify(inputPath)});p.parent.mkdir(parents=True);p.write_text('current input')
(p.parent/'.manifest.json').write_text(json.dumps(dict(id='input123',path=str(p),name='sample.txt',mimeType='text/plain')))
`,
  ]);
  const inputAudit = await request('/files/input-metadata', {
    ...scope,
    id: 'input123',
    secrets: [issuedDeviceCredential],
  });
  assert.equal(inputAudit.status, 200);
  assert.equal(
    (await inputAudit.json()).digest,
    createHash('sha256').update('current input').digest('hex'),
  );
  docker([
    'exec',
    name,
    'python3',
    '-c',
    `import pathlib;p=pathlib.Path(${JSON.stringify(inputPath)});p.write_text(${JSON.stringify(issuedDeviceCredential)})`,
  ]);
  assert.equal(
    (
      await request('/files/input-metadata', {
        ...scope,
        id: 'input123',
        secrets: [issuedDeviceCredential],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('/files/input', {
        ...scope,
        id: 'input123',
        secrets: [issuedDeviceCredential],
      })
    ).status,
    400,
  );
  const response = await request('/files/read', {
    ...scope,
    path: 'documents/large.bin',
  });
  assert.equal(response.status, 200);
  let bytes = 0;
  for await (const chunk of response.body) bytes += chunk.length;
  assert.equal(bytes, 17 * 1024 * 1024);
  console.log(
    JSON.stringify({
      passed: true,
      inputSecretMetadataRejected: true,
      authorization: true,
      ownership: true,
      privateAndSymlinkRejected: true,
      currentReadNotStale: true,
      streamedBytes: bytes,
    }),
  );
} finally {
  try {
    docker(['rm', '-f', name]);
  } catch {
    /* cleaned */
  }
}
