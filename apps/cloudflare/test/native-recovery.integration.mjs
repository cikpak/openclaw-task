import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AwsClient } from 'aws4fetch';
/** Opt-in release proof: real private S3 transfers and a fresh restored Docker filesystem. */
export async function verifyNativeRecovery(context) {
  const credentials = JSON.parse(
    await readFile(process.env.OPENCLAW_RECOVERY_CREDENTIALS, 'utf8'),
  );
  const origin =
    'https://65cabd080cdf7a36f76d0e884752c249.r2.cloudflarestorage.com';
  const bucket = 'openclaw-messenger-verification-20261022';
  const aws = new AwsClient({
    accessKeyId: credentials.R2_ACCESS_KEY_ID,
    secretAccessKey: credentials.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const {
    exec,
    job,
    gateway,
    mapping,
    identity,
    app,
    directory,
    switchContainer,
    createGateway,
  } = context;
  const ownedPath = resolve(
    dirname(process.env.OPENCLAW_RECOVERY_CREDENTIALS),
    '../reviews/phase3-r2-owned-inventory.json',
  );
  const evidencePath = resolve(
    app,
    '../../.context/native-recovery-evidence.json',
  );
  const objects = new Map();
  let restored;
  const url = (key) =>
    `${origin}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const grants = async (list, method) =>
    Promise.all(
      list.map(async (object) => {
        const target = new URL(url(object.key));
        target.searchParams.set('X-Amz-Expires', '600');
        const request = await aws.sign(
          new Request(target, {
            method,
            headers: method === 'PUT' ? { 'content-md5': object.md5 } : {},
          }),
          { aws: { signQuery: true, allHeaders: true } },
        );
        return {
          key: object.key,
          url: request.url,
          ...(method === 'PUT'
            ? { headers: { 'content-md5': object.md5 } }
            : {}),
        };
      }),
    );
  try {
    const script = `const fs=require('node:fs'); fs.mkdirSync('/recovery/workspace/documents',{recursive:true}); fs.writeFileSync('/recovery/workspace/documents/restored-deliverable.txt','exact user-file content',{mode:0o640}); fs.writeFileSync('/recovery/home/private-working.txt','private working material',{mode:0o600}); fs.chownSync('/recovery/workspace/documents/restored-deliverable.txt',1000,1000); fs.chownSync('/recovery/home/private-working.txt',1000,1000);`;
    await exec('docker', [
      'exec',
      context.containerName(),
      'node',
      '-e',
      script,
    ]);
    const desired = {
      ...(await gateway.history(mapping)).settings,
      responseStyle: 'concise',
      personality: 'friendly',
      customInstructions: 'Retain the exact recovery verification setting.',
    };
    const settings = await gateway.settings(mapping, desired);
    const before = await gateway.history(mapping);
    await gateway.stop();
    await job('stop', {});
    const checkpointId = `native-${randomUUID()}`;
    const descriptor = await job('capture', { checkpointId });
    for (const object of [
      descriptor.archive,
      descriptor.manifest,
      ...descriptor.files,
    ])
      objects.set(object.key, object);
    await writeFile(
      ownedPath,
      JSON.stringify(
        [...objects.values()].map(({ key, sha256, size }) => ({
          key,
          sha256,
          size,
        })),
        null,
        2,
      ),
    );
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          bucket,
          descriptor,
          objects: [...objects.values()],
          stage: 'captured',
        },
        null,
        2,
      ),
    );
    const upload = await job('upload', {
      checkpointId,
      grants: await grants([...objects.values()], 'PUT'),
      readbackGrants: await grants([...objects.values()], 'GET'),
    });
    assert.ok(upload);
    for (const object of objects.values()) {
      const response = await aws.fetch(url(object.key));
      assert.equal(response.status, 200);
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of response.body) {
        hash.update(chunk);
        bytes += chunk.byteLength;
      }
      assert.equal(bytes, object.size);
      assert.equal(hash.digest('hex'), object.sha256);
    }
    const oldName = context.containerName();
    await exec('docker', ['stop', '--time', '30', oldName]);
    const nextName = `phase3-gateway-restore-${randomUUID().slice(0, 8)}`,
      bootId = randomUUID();
    const envPath = resolve(directory, 'restore.env');
    await writeFile(
      envPath,
      Object.entries({
        BOOT_ID: bootId,
        HELPER_TOKEN: context.helperToken,
        GATEWAY_TOKEN: context.gatewayToken,
        EXPECTED_MANAGER_DEVICE_ID: identity.deviceId,
        EXPECTED_MANAGER_PUBLIC_KEY: identity.publicKey,
        R2_ORIGIN: origin,
        RESTORE_EXPECTED: '1',
        NODE_COMPILE_CACHE: '/var/lib/messenger-helper/node-cache',
      })
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
      { mode: 0o600 },
    );
    try {
      await exec('docker', [
        'run',
        '-d',
        '--name',
        nextName,
        '--env-file',
        envPath,
        '-v',
        `${resolve(app, 'container')}:/opt/messenger-helper:ro`,
        '-p',
        '127.0.0.1::8787',
        '-p',
        '127.0.0.1::18789',
        context.image,
      ]);
    } finally {
      await rm(envPath, { force: true });
    }
    const port = async (internal) =>
      Number(
        (await exec('docker', ['port', nextName, internal])).stdout
          .trim()
          .split(':')
          .at(-1),
      );
    switchContainer({
      name: nextName,
      bootId,
      helperOrigin: `http://127.0.0.1:${await port('8787')}`,
      gatewayOrigin: `http://127.0.0.1:${await port('18789')}`,
    });
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        health = await context.request('/health');
        break;
      } catch {
        await delay(100);
      }
    }
    assert.equal(health?.restoreExpected, true);
    assert.equal(health?.gatewayState, 'stopped');
    await job('restore', {
      descriptor,
      grants: await grants([...objects.values()], 'GET'),
    });
    await job('start', {});
    restored = createGateway('intentionally-unused-shared-token');
    assert.deepEqual(await restored.identity(), identity);
    restored.start();
    await restored.waitReady(120000);
    restored.dispatch(true);
    const after = await restored.history(mapping);
    assert.equal(after.sessionId, before.sessionId);
    assert.deepEqual(after.settings, settings);
    assert.deepEqual(after.messages, before.messages);
    const proof = await exec('docker', [
      'exec',
      nextName,
      'node',
      '-e',
      `const fs=require('node:fs'),c=require('node:crypto'); console.log(JSON.stringify(['/recovery/workspace/documents/restored-deliverable.txt','/recovery/home/private-working.txt'].map(path=>{const s=fs.statSync(path);return {path,sha256:c.createHash('sha256').update(fs.readFileSync(path)).digest('hex'),uid:s.uid,gid:s.gid,mode:s.mode&511};})));`,
    ]);
    const files = JSON.parse(proof.stdout);
    assert.equal(
      files[0].sha256,
      createHash('sha256').update('exact user-file content').digest('hex'),
    );
    assert.equal(
      files[1].sha256,
      createHash('sha256').update('private working material').digest('hex'),
    );
    assert.equal(files[0].mode, 0o640);
    assert.equal(files[1].mode, 0o600);
    assert.ok(files.every((file) => file.uid === 1000 && file.gid === 1000));
    await restored.request('chat.inject', {
      ...mapping,
      message: 'Continuation after a fresh verified restore.',
    });
    assert.equal(
      (await restored.history(mapping)).messages.at(-1)?.text,
      'Continuation after a fresh verified restore.',
    );
    const result = {
      realR2ObjectsVerified: objects.size,
      freshContainerRestored: true,
      originalSessionIdRetained: true,
      originalSettingsRetained: true,
      completeHistoryRetained: true,
      privateAndDeliverableFilesRestored: true,
      ownershipModesRetained: true,
      restoredDeviceTokenAuthenticated: true,
      nativeContinuation: true,
    };
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          bucket,
          descriptor,
          objects: [...objects.values()],
          result,
          files,
          stage: 'verified',
        },
        null,
        2,
      ),
    );
    return result;
  } finally {
    await restored?.stop();
    for (const object of process.env.OPENCLAW_CLEANUP_VERIFICATION_OBJECTS ===
    '1'
      ? objects.values()
      : []) {
      const response = await aws.fetch(url(object.key), { method: 'DELETE' });
      assert.ok(response.ok, 'Owned verification object cleanup failed');
    }
  }
}
