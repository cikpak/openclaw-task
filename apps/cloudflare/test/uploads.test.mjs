import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const script = (
  await build({
    stdin: {
      contents: `
import {DurableObject} from 'cloudflare:workers';
import {UploadService} from './src/files/uploads/service.ts';
import {DurableObjectStore} from '../backend/src/storage/durable-object.ts';
import {ManagerAuthorization} from './src/manager/authorization.ts';
export class Probe extends DurableObject {
 constructor(ctx,env) {super(ctx,env);this.store=new DurableObjectStore(ctx.storage);this.authorization=new ManagerAuthorization(env,this.store);this.uploads=new UploadService({state:ctx,store:this.store,env:{RECOVERY_BUCKET:env.BUCKET,R2_SECRET_ACCESS_KEY:env.R2_SECRET_ACCESS_KEY}},this.authorization);}
 async fetch(request) {
  const input=await request.json();
  try {
   if(input.action==='status') {
    const row=this.uploads.lookup(input.id);const exists=!!(await this.env.BUCKET.head(row.key));const quota=this.store.db.prepare('SELECT count(*) AS count,sum(size) AS size FROM staged_uploads').get();return Response.json({status:row.status,completeObjectExists:exists,quota});
   }
   if(input.action==='inspect') {
    const row=this.uploads.lookup(input.id);const object=await this.env.BUCKET.get(row.key);
    const digest=new crypto.DigestStream('SHA-256');await object.body.pipeTo(digest);
    return Response.json({row,size:object.size,digest:Buffer.from(await digest.digest).toString('hex')});
   }
   if(input.action==='corrupt') {
    const [chunk]=this.uploads.database.chunks(input.id);await this.env.BUCKET.put(chunk.key,new Uint8Array(chunk.size).fill(98));return Response.json({});
   }
   if(input.action==='expire') {
    this.store.db.prepare('UPDATE staged_uploads SET expires_at=0 WHERE id=?').run(input.id);await this.uploads.cleanup();return Response.json({exists:!!this.uploads.lookup(input.id)});
   }
   return Response.json(await this.uploads.handle(input,'owner'));
  } catch(error) {return Response.json({error:error.code??'INTERNAL_ERROR',message:error.message},{status:error.status??500});}
 }
}
export default {fetch(request,env){return env.PROBE.getByName('uploads').fetch(request);}};`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['node:*', 'cloudflare:*'],
    write: false,
  })
).outputFiles[0].text;
async function runtime(path) {
  return new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: path,
      modules: true,
      script,
      compatibilityDate: '2026-10-22',
      compatibilityFlags: ['nodejs_compat'],
      r2Buckets: { BUCKET: 'uploads' },
      bindings: { R2_SECRET_ACCESS_KEY: 'known-test-only-account-secret' },
      durableObjects: { PROBE: { className: 'Probe', useSQLite: true } },
    }),
  );
}
async function send(mf, input, status = 200) {
  const response = await mf.dispatchFetch('https://uploads/', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}
function command(type, input = {}) {
  return { type, commandId: randomUUID(), ...input };
}
test('actual Workers R2 bounded chunks survive full process restart and complete a five MiB UTF-8 object exactly', async () => {
  const path = await mkdtemp(join(tmpdir(), 'messenger-uploads-'));
  let mf = await runtime(path);
  try {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 97),
      chunkSize = 48 * 1024;
    const initial = command('upload.begin', {
      name: 'large.txt',
      mimeType: 'text/plain',
      size: bytes.length,
    });
    const { uploadId } = await send(mf, initial);
    assert.equal((await send(mf, initial)).uploadId, uploadId);
    const first = command('upload.chunk', {
      uploadId,
      offset: 0,
      base64: bytes.subarray(0, chunkSize).toString('base64'),
    });
    await send(mf, first);
    await mf.dispose();
    mf = await runtime(path);
    assert.equal((await send(mf, first)).nextOffset, chunkSize);
    assert.equal(
      (
        await send(
          mf,
          command('upload.chunk', {
            uploadId,
            offset: 0,
            base64: Buffer.alloc(chunkSize, 98).toString('base64'),
          }),
          409,
        )
      ).error,
      'UPLOAD_CHUNK_CONFLICT',
    );
    for (let offset = chunkSize; offset < bytes.length; offset += chunkSize) {
      const result = await send(
        mf,
        command('upload.chunk', {
          uploadId,
          offset,
          base64: bytes.subarray(offset, offset + chunkSize).toString('base64'),
        }),
      );
      assert.equal(
        result.nextOffset,
        Math.min(offset + chunkSize, bytes.length),
      );
    }
    const finished = await send(mf, command('upload.complete', { uploadId }));
    assert.equal(finished.upload.size, bytes.length);
    const saved = await send(mf, { action: 'inspect', id: uploadId });
    assert.equal(saved.size, bytes.length);
    assert.equal(saved.row.status, 'complete');
    assert.equal(
      saved.digest,
      createHash('sha256').update(bytes).digest('hex'),
    );
    assert.equal(saved.digest, saved.row.sha256);
    assert.deepEqual(
      (await send(mf, command('upload.complete', { uploadId }))).upload,
      finished.upload,
    );
    assert.equal(
      (await send(mf, { action: 'expire', id: uploadId })).exists,
      false,
    );
  } finally {
    await mf.dispose();
    await rm(path, { recursive: true, force: true });
  }
});
test('actual Workers refuses corrupt storage and oversized chunks without committing completion', async () => {
  const path = await mkdtemp(join(tmpdir(), 'messenger-uploads-corrupt-')),
    mf = await runtime(path);
  try {
    const { uploadId } = await send(
      mf,
      command('upload.begin', {
        name: 'small.txt',
        mimeType: 'text/plain',
        size: 5,
      }),
    );
    assert.equal(
      (await send(mf, command('upload.complete', { uploadId }), 409)).error,
      'UPLOAD_INCOMPLETE',
    );
    assert.equal(
      (
        await send(
          mf,
          command('upload.chunk', {
            uploadId,
            offset: 0,
            base64: Buffer.alloc(48 * 1024 + 1).toString('base64'),
          }),
          400,
        )
      ).error,
      'INVALID_REQUEST',
    );
    await send(
      mf,
      command('upload.chunk', {
        uploadId,
        offset: 0,
        base64: Buffer.from('hello').toString('base64'),
      }),
    );
    await send(mf, { action: 'corrupt', id: uploadId });
    assert.equal(
      (await send(mf, command('upload.complete', { uploadId }), 500)).error,
      'INTERNAL_ERROR',
    );
  } finally {
    await mf.dispose();
    await rm(path, { recursive: true, force: true });
  }
});
test('actual Workers refuses known account secret split across staged chunks without a final object or quota release', async () => {
  const path = await mkdtemp(join(tmpdir(), 'messenger-upload-secret-')),
    mf = await runtime(path);
  try {
    const secret = 'known-test-only-account-secret',
      bytes = Buffer.concat([
        Buffer.alloc(48 * 1024 - 7, 97),
        Buffer.from(secret),
        Buffer.from(' trailing user text'),
      ]);
    const { uploadId } = await send(
      mf,
      command('upload.begin', {
        name: 'private.txt',
        mimeType: 'text/plain',
        size: bytes.length,
      }),
    );
    for (let offset = 0; offset < bytes.length; offset += 48 * 1024)
      await send(
        mf,
        command('upload.chunk', {
          uploadId,
          offset,
          base64: bytes.subarray(offset, offset + 48 * 1024).toString('base64'),
        }),
      );
    const rejected = await send(
      mf,
      command('upload.complete', { uploadId }),
      422,
    );
    assert.equal(rejected.error, 'UPLOAD_SENSITIVE_CONTENT');
    assert.equal(JSON.stringify(rejected).includes(secret), false);
    assert.deepEqual(await send(mf, { action: 'status', id: uploadId }), {
      status: 'staging',
      completeObjectExists: false,
      quota: { count: 1, size: bytes.length },
    });
    await send(mf, command('upload.remove', { uploadId }));
  } finally {
    await mf.dispose();
    await rm(path, { recursive: true, force: true });
  }
});
