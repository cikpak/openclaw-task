import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
let mf;
before(async () => {
  const bundle = await build({
    stdin: {
      contents: `
import {DurableObject} from 'cloudflare:workers';
import {DurableObjectStore} from '../backend/src/storage/durable-object.ts';
import {FileReaders} from './src/files/readers.ts';
import {RecoveryGarbage} from './src/files/garbage.ts';
import {EngineDriver} from './src/engine/driver.ts';
import {RecoveryObjects} from './src/engine/recovery/objects.ts';
export class GarbageProbe extends DurableObject {
 async fetch(request) {
  const action=new URL(request.url).pathname.slice(1);
  const store=new DurableObjectStore(this.ctx.storage),bucket=this.env.BUCKET;
  store.db.exec('CREATE TABLE IF NOT EXISTS engine_lifecycle(id INTEGER PRIMARY KEY,state TEXT); CREATE TABLE IF NOT EXISTS recovery_references(id INTEGER PRIMARY KEY,current TEXT,previous TEXT); CREATE TABLE IF NOT EXISTS input_file_paths(id TEXT,path TEXT,object_key TEXT)');
  store.db.prepare('INSERT INTO engine_lifecycle VALUES(1,?)').run(JSON.stringify({phase:'ready',job:null,pendingCheckpoint:null}));
  const bytesA=new TextEncoder().encode('AAA'),bytesB=new Uint8Array(action==='reader'?5*1024*1024:3).fill(98);
  const hash=async(bytes)=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const shaA=await hash(bytesA),shaB=await hash(bytesB);
  const object=(key,sha,size)=>({key,sha256:sha,size,md5:'YWFhYWFhYWFhYWFhYWFhYQ=='});
  const descriptor=(generation,sha,size,key='files/'+generation+'/'+sha)=>({version:1,checkpointId:generation,archive:object('recovery/'+generation+'/internal.tar.gz',sha,3),manifest:object('recovery/'+generation+'/manifest.json',sha,3),files:[{...object(key,sha,size),path:'documents/answer.txt',mode:420,uid:1000,gid:1000}],inventoryDigest:sha,counts:{entries:1,userFiles:1,databases:0}});
  const checkpoint=(descriptor)=>({generation:descriptor.checkpointId,manifestKey:descriptor.manifest.key,manifestSha256:descriptor.manifest.sha256,descriptor});
  const A=checkpoint(descriptor('generation-A',shaA,bytesA.length));
  const B=checkpoint(descriptor('generation-B',shaB,bytesB.length));
  const C=checkpoint(descriptor('generation-C',shaB,bytesB.length));
  const keyA=A.descriptor.files[0].key,keyB=B.descriptor.files[0].key,keyC=C.descriptor.files[0].key;
  await bucket.put(keyA,bytesA);await bucket.put(keyB,bytesB);
  const readers=new FileReaders(store),files={catalog:{pinnedKeys:()=>[]},uploads:{pinnedKeys:()=>[]},readers};
  const context={state:this.ctx,store,env:{RECOVERY_BUCKET:bucket}};
  const driver=Object.create(EngineDriver.prototype);driver.context=context;driver.objects=new RecoveryObjects(context.env);driver.onCommit=()=>{};
  const commit=value=>this.ctx.storage.transactionSync(()=>driver.commit(value));
  commit(A);
  if(action==='tombstones') {
   let rejected=0;
   for(const key of [keyC,C.descriptor.archive.key,C.descriptor.manifest.key]) {
    readers.beginDelete(key);try{commit(C);}catch{rejected++;}readers.endDelete(key);
   }
   const current=JSON.parse(store.db.prepare('SELECT current FROM recovery_references WHERE id=1').get().current);
   return Response.json({rejected,currentGeneration:current.generation,currentExists:!!(await bucket.head(keyA))});
  }
  if(action==='reader') {
   const object=await bucket.get(keyB),lease=readers.admit(false,keyB),body=readers.stream(object.body,lease).getReader();
   const first=await body.read();const garbage=new RecoveryGarbage(context,files);await garbage.collect();
   const pinned=!!(await bucket.head(keyB))&&readers.keys().has(keyB);
   let bytes=first.value.length;for(;;){const next=await body.read();if(next.done)break;bytes+=next.value.length;}
   await new RecoveryGarbage(context,files).collect();
   return Response.json({pinned,bytes,deletedAfterFinish:(await bucket.head(keyB))===null,currentSurvives:!!(await bucket.head(keyA)),readers:readers.keys().size});
  }
  if(action==='restore') {
   await this.ctx.storage.put('engine-helper-restore-job',{settled:false,job:{id:'restore-job',kind:'restore',checkpoint:B}});
   await new RecoveryGarbage(context,files).collect();const pinned=!!(await bucket.head(keyB));
   await this.ctx.storage.put('engine-helper-restore-job',{settled:true,job:{id:'restore-job',kind:'restore',checkpoint:B}});
   await new RecoveryGarbage(context,files).collect();
   return Response.json({pinned,deletedAfterSettle:(await bucket.head(keyB))===null,settledRecordRemoved:!(await this.ctx.storage.get('engine-helper-restore-job'))});
  }
  let entered,release;const whenEntered=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  let attempts=0,secondPages=0,uncertain=action==='uncertain';
  const wrapped={
   list:async(options)=>{
    if(options.prefix!=='files/')return bucket.list(options);
    if(!options.cursor)return {objects:[{key:keyB}],truncated:true,cursor:'after-old-B'};
    secondPages++;const actual=await bucket.list({prefix:'files/'});return {...actual,objects:actual.objects.filter(file=>file.key!==keyB),truncated:false};
   },
   delete:async(key)=>{
    if(key===keyB && ++attempts===1){entered();await gate;if(uncertain)throw new Error('uncertain delete');}
    return bucket.delete(key);
   },
  };
  context.env={RECOVERY_BUCKET:wrapped};
  const collecting=new RecoveryGarbage(context,files).collect();await whenEntered;
  const fenced=readers.deleting(keyB);await bucket.put(keyC,bytesB);commit(C);
  let staleReuseRejected=false;
  try {commit(checkpoint(descriptor('generation-D',shaB,bytesB.length,keyB)));}catch{staleReuseRejected=true;}
  release();let failed=false;try{await collecting;}catch{failed=true;}
  const tombstoneBeforeRetry=readers.deleting(keyB);
  // A fresh service instance resumes durable tombstones after an uncertain request.
  await new RecoveryGarbage(context,files).collect();
  const current=JSON.parse(store.db.prepare('SELECT current FROM recovery_references WHERE id=1').get().current);
  return Response.json({fenced,failed,tombstoneBeforeRetry,tombstoneAfterRetry:readers.deleting(keyB),staleReuseRejected,secondPages,currentGeneration:current.generation,currentExists:!!(await bucket.head(keyC)),oldDeleted:(await bucket.head(keyB))===null});
 }
}
export default {fetch(request,env){return env.PROBE.getByName(new URL(request.url).pathname).fetch(request);}};`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['node:*', 'cloudflare:*'],
    write: false,
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-10-22',
      compatibilityFlags: ['nodejs_compat'],
      r2Buckets: { BUCKET: 'garbage-regression' },
      durableObjects: { PROBE: { className: 'GarbageProbe', useSQLite: true } },
    }),
  );
});
after(async () => {
  await mf?.dispose();
});
async function probe(action) {
  const response = await mf.dispatchFetch(`https://probe/${action}`);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
test('delayed old deletion and a later R2 listing page cannot remove a newly committed content recurrence', async () => {
  const result = await probe('delayed');
  assert.equal(result.fenced, true);
  assert.equal(result.failed, false);
  assert.equal(result.staleReuseRejected, true);
  assert.equal(result.currentGeneration, 'generation-C');
  assert.equal(result.currentExists, true);
  assert.equal(result.oldDeleted, true);
  assert.ok(result.secondPages >= 1);
});
test('uncertain delete leaves a durable fence and a restarted collector safely retries the old incarnation', async () => {
  const result = await probe('uncertain');
  assert.equal(result.fenced, true);
  assert.equal(result.failed, true);
  assert.equal(result.tombstoneBeforeRetry, true);
  assert.equal(result.tombstoneAfterRetry, false);
  assert.equal(result.currentExists, true);
  assert.equal(result.oldDeleted, true);
  assert.equal(result.staleReuseRejected, true);
});
test('an admitted R2 reader pins an old incarnation until the full stream finishes', async () => {
  assert.deepEqual(await probe('reader'), {
    pinned: true,
    bytes: 5 * 1024 * 1024,
    deletedAfterFinish: true,
    currentSurvives: true,
    readers: 0,
  });
});
test('unsettled restore checkpoint descriptors pin their objects until the job settles', async () => {
  assert.deepEqual(await probe('restore'), {
    pinned: true,
    deletedAfterSettle: true,
    settledRecordRemoved: true,
  });
});

test('commit refuses file, archive and manifest objects with an unresolved durable deletion fence', async () => {
  assert.deepEqual(await probe('tombstones'), {
    rejected: 3,
    currentGeneration: 'generation-A',
    currentExists: true,
  });
});
