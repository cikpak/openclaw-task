import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
if (!process.env.OPENCLAW_TEST_IMAGE)
  throw new Error('Select the pinned helper image');
const script = `
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {upload} from './transfers.mjs';
import {verifyRemote} from './readback.mjs';
import {createJobs} from './jobs.mjs';
const bytes=Buffer.from('immutable image helper readback');
const sha256=createHash('sha256').update(bytes).digest('hex');
const object=key=>({key,size:bytes.length,sha256,md5:createHash('md5').update(bytes).digest('base64')});
const descriptor={version:1,checkpointId:'image-readback',archive:object('recovery/image-readback/internal.tar.gz'),manifest:object('recovery/image-readback/manifest.json'),files:[object('files/image-readback/'+sha256)]};
const all=[descriptor.archive,descriptor.manifest,...descriptor.files];
const origin=process.env.R2_ORIGIN;
const grant=key=>({key,url:origin+'/bucket/'+key+'?signature=private'});
const getGrants=all.map(({key})=>grant(key));
const putGrants=all.slice(0,2).map(({key,md5})=>({...grant(key),headers:{'content-md5':md5}}));
const stage='/tmp/readback-stage';await mkdir(stage);await writeFile(stage+'/internal.tar.gz',bytes);await writeFile(stage+'/manifest.json',bytes);
const remote=new Map([[descriptor.files[0].key,bytes]]);const gets=[],puts=[];let mode='valid';
globalThis.fetch=async(url,init)=>{
 assert.equal(init.redirect,'error');assert.ok(init.signal);const key=decodeURIComponent(new URL(url).pathname).split('/').slice(2).join('/');
 if(init.method==='PUT'){const chunks=[];for await(const chunk of init.body)chunks.push(chunk);remote.set(key,Buffer.concat(chunks));puts.push(key);return new Response(null,{status:200});}
 assert.equal(init.method,'GET');gets.push(key);if(mode==='missing')return new Response(null,{status:404});
 const body=remote.get(key);return new Response(mode==='corrupt'?Buffer.alloc(body.length):mode==='short'?body.subarray(1):mode==='oversized'?Buffer.concat([body,body]):body);
};
const result=await upload(stage,descriptor,putGrants,[descriptor.files[0].key],new AbortController().signal,getGrants);
assert.equal(result.uploaded,true);assert.equal(result.verification.count,3);assert.deepEqual(puts,all.slice(0,2).map(object=>object.key));assert.deepEqual(gets,all.map(object=>object.key));
const tuples=all.map(({key,size,sha256})=>[key,size,sha256]).sort((a,b)=>a[0]<b[0]?-1:1);
assert.equal(result.verification.objectsSha256,createHash('sha256').update(JSON.stringify(tuples)).digest('hex'));assert.ok(JSON.stringify(result).length<300);
for(mode of ['corrupt','short','oversized','missing'])await assert.rejects(()=>upload(stage,descriptor,putGrants,[descriptor.files[0].key],new AbortController().signal,getGrants));
await assert.rejects(()=>verifyRemote(descriptor,getGrants.slice(1),new AbortController().signal));
let release,cancelled=false;
globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,2));release=()=>controller.enqueue(bytes.subarray(2));},cancel(){cancelled=true;}}));
const jobs=createJobs('image-boot',{upload:(_data,signal)=>verifyRemote(descriptor,getGrants,signal)});
const payload={operationId:'upload-image-readback',bootId:'image-boot',action:'upload'};
assert.equal(jobs.start({...payload,bootId:'stale'}).code,400);assert.equal(jobs.start(payload).code,202);
await new Promise(resolve=>setImmediate(resolve));jobs.cancel(payload.operationId);release();await jobs.settle();
assert.equal(jobs.get(payload.operationId).status,'cancelled');assert.equal(cancelled,true);
console.log(JSON.stringify({passed:true,productionImageModule:true,allObjectsIncludingReused:true,exactSha256Receipt:true,corruptionMissingWrongSizeRejected:true,streamCancellationFenced:true,staleBootRejected:true}));
`;
test('immutable production helper directly verifies upload readback and cancellation', () => {
  const output = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--entrypoint',
      'node',
      '--env',
      'R2_ORIGIN=https://abc123.r2.cloudflarestorage.com',
      process.env.OPENCLAW_TEST_IMAGE,
      '--input-type=module',
    ],
    {
      input: script,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    },
  );
  const result = JSON.parse(output.trim());
  assert.equal(result.passed, true);
  console.info(
    JSON.stringify({ ...result, image: process.env.OPENCLAW_TEST_IMAGE }),
  );
});
