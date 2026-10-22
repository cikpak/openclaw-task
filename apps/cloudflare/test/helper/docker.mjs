// Run explicitly: node apps/cloudflare/test/helper/docker.mjs [image]. No provider is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detachedWriters } from './detached-writers.mjs';
import { excludedWorkspace } from './path-audit.mjs';
const image = process.argv[2] ?? 'messenger-phase3-helper:local';
const name = `messenger-helper-test-${randomUUID().slice(0, 8)}`;
const token = randomBytes(32).toString('hex'),
  key = randomBytes(32),
  publicKey = key.toString('base64url');
const identity = {
  publicKey,
  deviceId: createHash('sha256').update(key).digest('hex'),
  role: 'operator',
  scopes: ['operator.read', 'operator.write', 'operator.admin'],
};
const docker = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
const temporary = mkdtempSync(join(tmpdir(), 'messenger-helper-'));
let base;
async function request(path, data, authorization = token) {
  const result = await fetch(`${base}${path}`, {
    method: data ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${authorization}`,
      'content-type': 'application/json',
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: result.status, value: await result.json() };
}
async function job(action, data, id = randomUUID()) {
  const started = await request('/jobs', {
    operationId: id,
    bootId: 'test-boot',
    action,
    data,
  });
  assert.equal(started.status, 202);
  for (let count = 0; count < 600; count++) {
    const { value } = await request(`/jobs/${id}`);
    if (value.finishedAt) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Helper job timeout');
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
    'BOOT_ID=test-boot',
    image,
  ]);
  base = `http://${docker(['port', name, '8787/tcp']).trim()}`;
  for (let count = 0; ; count++) {
    try {
      await request('/health');
      break;
    } catch {
      if (count > 50) throw new Error('Helper startup failed');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal((await request('/health', undefined, 'wrong')).status, 401);
  assert.equal((await job('start')).status, 'failed');
  assert.equal(
    (
      await job('initialize', {
        identity: { ...identity, deviceId: '0'.repeat(64) },
      })
    ).status,
    'failed',
  );
  assert.equal((await job('initialize', { identity })).status, 'succeeded');
  assert.equal((await job('initialize', { identity })).status, 'failed');
  assert.equal(
    (
      await request('/jobs', {
        operationId: 'stale',
        bootId: 'old',
        action: 'start',
      })
    ).status,
    400,
  );
  const fixture = `import os,pathlib\nr=pathlib.Path('/recovery')\n(r/'workspace/documents').mkdir()\nfor i in range(65): (r/'workspace/documents'/('document-'+str(i))).write_text('content-'+str(i))\n(r/'private').mkdir()\n(r/'private/unknown').write_text('private state')\nos.chown(r/'private/unknown',777,778)\nos.chmod(r/'private/unknown',0o640)\nos.symlink('../private/unknown',r/'workspace/safe-link')\nwith open(r/'private/large','wb') as f:f.truncate(129*1024*1024)\n`;
  docker(['exec', name, 'python3', '-c', fixture]);
  docker([
    'exec',
    name,
    'node',
    '--input-type=module',
    '-e',
    "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync('/recovery/private/nonstandard.db');d.exec('PRAGMA journal_mode=WAL;CREATE TABLE saved(value TEXT)');d.prepare('INSERT INTO saved VALUES(?)').run('durable');process.exit(0)",
  ]);
  assert.equal(
    docker([
      'exec',
      name,
      'python3',
      '-c',
      "import pathlib;assert pathlib.Path('/recovery/private/nonstandard.db-wal').exists();assert pathlib.Path('/recovery/private/nonstandard.db-shm').exists();print('wal-present')",
    ]).trim(),
    'wal-present',
  );
  assert.equal((await request('/fixture')).status, 404);
  assert.equal(
    (
      await request('/jobs/cancelled-before-start/cancel', {
        bootId: 'test-boot',
      })
    ).value.status,
    'cancelled',
  );
  assert.equal(
    (
      await job(
        'capture',
        { checkpointId: 'must-not-run' },
        'cancelled-before-start',
      )
    ).status,
    'cancelled',
  );
  await detachedWriters(docker, name, job);
  await excludedWorkspace(docker, name, job);
  const captured = await job('capture', { checkpointId: 'test-generation' });
  assert.equal(captured.status, 'succeeded');
  assert.equal(captured.result.counts.userFiles, 65);
  assert.equal(captured.result.counts.databases, 1);
  const duplicate = await request('/jobs', {
    operationId: captured.operationId,
    bootId: 'test-boot',
    action: 'capture',
    data: { checkpointId: 'test-generation' },
  });
  assert.equal(duplicate.status, 202);
  assert.equal(
    (
      await request('/jobs', {
        operationId: captured.operationId,
        bootId: 'test-boot',
        action: 'stop',
      })
    ).status,
    409,
  );
  docker([
    'exec',
    name,
    'python3',
    '-c',
    "import os,pathlib;os.symlink('/etc/passwd','/recovery/private/escaping')",
  ]);
  assert.equal(
    (await job('capture', { checkpointId: 'unsafe-generation' })).status,
    'failed',
  );
  docker([
    'exec',
    name,
    'python3',
    '-c',
    "import pathlib;pathlib.Path('/recovery/private/escaping').unlink()",
  ]);
  docker([
    'cp',
    `${name}:/var/lib/messenger-helper/staging/test-generation`,
    temporary,
  ]);
  const corruptCode =
    "import pathlib,json,shutil;from snapshot_restore import restore;root=pathlib.Path('/fresh');root.mkdir();stage=pathlib.Path('/damaged');shutil.copytree('/saved',stage);file=next(stage.glob('user-*'));file.write_bytes(b'corrupted');descriptor=json.loads((stage/'descriptor.json').read_text())\ntry: restore(stage,descriptor)\nexcept ValueError: assert not list(root.iterdir());print('corruption-rejected-before-mutation')\nelse: raise AssertionError('corrupt object accepted')";
  assert.equal(
    docker([
      'run',
      '--rm',
      '--entrypoint',
      'python3',
      '-e',
      'RECOVERY_ROOT=/fresh',
      '-v',
      `${join(temporary, 'test-generation')}:/saved:ro`,
      image,
      '-c',
      corruptCode,
    ]).trim(),
    'corruption-rejected-before-mutation',
  );
  // A second process restores the checkpoint to an actually empty independent tree.
  const restoreCode =
    "import json,pathlib;from snapshot_restore import restore;p=pathlib.Path('/saved');print(json.dumps(restore(p,json.loads((p/'descriptor.json').read_text()))))";
  const restored = JSON.parse(
    docker([
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      '-e',
      'RECOVERY_ROOT=/fresh',
      '-v',
      `${join(temporary, 'test-generation')}:/saved:ro`,
      image,
      '-c',
      `mkdir /fresh; python3 -c '${restoreCode.replaceAll("'", "'\"'\"'")}'`,
    ]),
  );
  assert.equal(restored.restored, true);
  assert.equal(restored.inventoryDigest, captured.result.inventoryDigest);
  assert.equal(restored.databases.length, 1);
  console.log(
    JSON.stringify({
      helper: 'passed',
      authorization: true,
      pristineGate: true,
      identityFence: true,
      staleBoot: true,
      jobIdempotency: true,
      documents: 65,
      privateLargeBytes: 129 * 1024 * 1024,
      corruptionRejectedBeforeMutation: true,
      sqliteSidecars: true,
      detachedEngineAndRootWritersRejected: true,
      excludedWorkspaceSymlinkRejected: true,
      arbitraryOwnership: true,
      safeSymlink: true,
      escapingSymlinkRejected: true,
      sqlite: true,
      restoredDigest: restored.inventoryDigest,
    }),
  );
} finally {
  try {
    docker(['rm', '-f', name]);
  } catch {
    /* Test container may already have stopped. */
  }
  rmSync(temporary, { recursive: true, force: true });
}
