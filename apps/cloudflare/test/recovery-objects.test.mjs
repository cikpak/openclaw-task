import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('actual Workers verifies recovery metadata without receiving object bodies before durable reference commit', async () => {
  const bundle = await build({
    stdin: {
      contents: `
      import {DurableObject} from 'cloudflare:workers';
      import {createHash} from 'node:crypto';
      import {RecoveryObjects} from './src/engine/recovery/objects.ts';
      import {EngineDriver} from './src/engine/driver.ts';
      import {DurableObjectStore} from '../backend/src/storage/durable-object.ts';
      export class Probe extends DurableObject {
        async fetch(request) {
          const store = new DurableObjectStore(this.ctx.storage);
          store.db.exec('CREATE TABLE IF NOT EXISTS recovery_references (id INTEGER PRIMARY KEY CHECK(id = 1), current TEXT NOT NULL, previous TEXT)');
          const driver = new EngineDriver({store,env:{RECOVERY_BUCKET:this.env.BUCKET}},null,null,null);
          const input = new Uint8Array(5 * 1024 * 1024 + 113).fill(97);
          const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256',input)).toString('hex');
          const object = key => ({key,size:input.length,sha256,md5:createHash('md5').update(input).digest('base64')});
          const descriptor = {version:1,checkpointId:'generation-a',archive:object('recovery/generation-a/internal.tar.gz'),manifest:object('recovery/generation-a/manifest.json'),files:[],inventoryDigest:sha256,counts:{entries:1,userFiles:0,databases:0}};
          const checkpoint = {generation:descriptor.checkpointId,manifestKey:descriptor.manifest.key,manifestSha256:sha256,descriptor};
          let bodyReads=0;
          const metadataOnly={head:key=>this.env.BUCKET.head(key),get(){bodyReads++;throw Error('Forbidden manager body read');}};
          const objects = new RecoveryObjects({RECOVERY_BUCKET:metadataOnly});
          await this.env.BUCKET.put(descriptor.archive.key,input);
          await this.env.BUCKET.put(descriptor.manifest.key,input);
          await objects.verify(checkpoint);
          const oldDescriptor = {...descriptor,checkpointId:'old',archive:object('recovery/old/internal.tar.gz'),manifest:object('recovery/old/manifest.json')};
          const old = {generation:'old',manifestKey:oldDescriptor.manifest.key,manifestSha256:sha256,descriptor:oldDescriptor};
          await this.env.BUCKET.put(oldDescriptor.archive.key,input);
          await this.env.BUCKET.put(oldDescriptor.manifest.key,input);
          await objects.verify(old);
          this.ctx.storage.transactionSync(() => driver.commit(old));
          this.ctx.storage.transactionSync(() => driver.commit(checkpoint));
          this.ctx.storage.transactionSync(() => driver.commit(checkpoint));
          const row = store.db.prepare('SELECT current,previous FROM recovery_references WHERE id=1').get();
          await this.env.BUCKET.put(descriptor.archive.key,new Uint8Array(input.length).fill(98));
          let corruptRejected=false;
          try { await objects.verify(checkpoint); } catch { corruptRejected=true; }
          await this.env.BUCKET.put(descriptor.archive.key,input);
          let polls=0,cancelled=false;
          try { await objects.verify(checkpoint,{shouldCancel:()=>++polls>1}); } catch(error) { cancelled=error.message==='Preservation cancelled'; }
          await this.env.BUCKET.delete(descriptor.archive.key);
          let missingRejected=false;
          try { await objects.verify(checkpoint); } catch { missingRejected=true; }
          return Response.json({current:JSON.parse(row.current).generation,previous:JSON.parse(row.previous).generation,corruptRejected,missingRejected,cancelled,bodyReads});
        }
      }
      export default { fetch(request,env) {return env.PROBE.getByName('primary').fetch(request);} };`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['node:*', 'cloudflare:*'],
    write: false,
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-10-22',
      compatibilityFlags: ['nodejs_compat'],
      r2Buckets: { BUCKET: 'recovery' },
      durableObjects: { PROBE: { className: 'Probe', useSQLite: true } },
    }),
  );
  try {
    const response = await mf.dispatchFetch('https://probe/verify');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      current: 'generation-a',
      previous: 'old',
      corruptRejected: true,
      missingRejected: true,
      cancelled: true,
      bodyReads: 0,
    });
  } finally {
    await mf.dispose();
  }
});
