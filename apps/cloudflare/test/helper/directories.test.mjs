import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
if (!process.env.OPENCLAW_TEST_IMAGE)
  throw new Error('Select the pinned helper image');
const script = `
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm,chown,chmod,stat,symlink} from 'node:fs/promises';
import fs,{mkdirSync,chownSync,chmodSync,renameSync}from'node:fs';
import {randomBytes,createHash}from'node:crypto';
import childProcess from'node:child_process';
import {syncBuiltinESMExports}from'node:module';
import {environment}from'./environment.mjs';
import {initialize}from'./configuration.mjs';
import {handoff}from'./files-handoff.mjs';
import {inputDirectory}from'./files-input.mjs';
environment();await mkdir('/recovery',{recursive:true});
const key=randomBytes(32),publicKey=key.toString('base64url');
const identity={deviceId:createHash('sha256').update(key).digest('hex'),publicKey,role:'operator',scopes:['operator.admin','operator.read','operator.write']};
process.env.EXPECTED_MANAGER_DEVICE_ID=identity.deviceId;process.env.EXPECTED_MANAGER_PUBLIC_KEY=publicKey;
await initialize({identity});const mapping={agentId:'main',sessionKey:'agent:main:main'};
const documents='/recovery/workspace/documents';await assert.rejects(()=>stat(documents));
globalThis.fetch=async()=>new Response('test');
const result=await handoff({...mapping,uploads:[{id:'input123',name:'sample.txt',mimeType:'text/plain',size:4,sha256:createHash('sha256').update('test').digest('hex'),key:'staging/uploads/input123/content',url:'https://account.r2.cloudflarestorage.com/bucket/staging/uploads/input123/content?signature=private'}]});
let metadata=await stat(documents);assert.equal(metadata.uid,1000);assert.equal(metadata.gid,1000);assert.equal(metadata.mode&0o777,0o755);
const nativeWrite="import{u as createWriteTool}from'/app/dist/tools-ByVn7L4O.mjs';const tool=createWriteTool('/recovery/workspace');await tool.execute('write-after-import',{path:'documents/after-import.txt',content:'native deliverable after attachment'},new AbortController().signal);";
childProcess.execFileSync(process.execPath,['--input-type=module','-e',nativeWrite],{uid:1000,gid:1000,env:{},stdio:'pipe'});
assert.equal(await readFile(documents+'/after-import.txt','utf8'),'native deliverable after attachment');
const base=await inputDirectory(mapping);for(const path of [documents+'/.messenger-inputs',base,base+'/input123']){const value=await stat(path);assert.equal(value.uid,0);assert.equal(value.mode&0o022,0);}
assert.throws(()=>childProcess.execFileSync(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],'changed')",base+'/injected'],{uid:1000,gid:1000,env:{},stdio:'ignore'}));
assert.equal(await readFile(result.uploads[0].path,'utf8'),'test');
await rm(documents,{recursive:true});await mkdir(documents);await chown(documents,777,778);await chmod(documents,0o751);
await inputDirectory(mapping,true);metadata=await stat(documents);assert.equal(metadata.uid,777);assert.equal(metadata.gid,778);assert.equal(metadata.mode&0o777,0o751);
await rm(documents,{recursive:true});const victim='/recovery/private-victim';await mkdir(victim);await chown(victim,555,556);await chmod(victim,0o701);await symlink(victim,documents);
await assert.rejects(()=>inputDirectory(mapping,true));metadata=await stat(victim);assert.equal(metadata.uid,555);assert.equal(metadata.gid,556);assert.equal(metadata.mode&0o777,0o701);await rm(documents);
const realSpawn=childProcess.spawn;
const intercept=(mutate)=>{childProcess.spawn=(command,args,options)=>{assert.equal(options.uid,1000);assert.equal(options.gid,1000);assert.deepEqual(options.env,{});mutate();return realSpawn(command,args,options);};syncBuiltinESMExports();};
intercept(()=>{mkdirSync(documents);chownSync(documents,777,778);chmodSync(documents,0o751);});
try{await inputDirectory(mapping,true);}finally{childProcess.spawn=realSpawn;syncBuiltinESMExports();}
metadata=await stat(documents);assert.equal(metadata.uid,777);assert.equal(metadata.gid,778);assert.equal(metadata.mode&0o777,0o751);await rm(documents,{recursive:true});
intercept(()=>{renameSync('/recovery/workspace','/recovery/workspace-moved');mkdirSync('/recovery/workspace');chownSync('/recovery/workspace',1000,1000);});
try{await assert.rejects(()=>inputDirectory(mapping,true));}finally{childProcess.spawn=realSpawn;syncBuiltinESMExports();}
await assert.rejects(()=>stat('/recovery/workspace/documents'));assert.equal((await stat('/recovery/workspace-moved/documents')).uid,1000);
await rm('/recovery/workspace',{recursive:true});renameSync('/recovery/workspace-moved','/recovery/workspace');
await inputDirectory(mapping,true);const outside='/tmp/input-swap-victim';await mkdir(outside);const originalMkdir=fs.promises.mkdir;let swapped=false;
fs.promises.mkdir=async(path,options)=>{if(String(path).startsWith('/proc/self/fd/')&&String(path).endsWith('/fenced-upload')){swapped=true;renameSync(documents+'/.messenger-inputs',documents+'/.messenger-inputs-moved');fs.symlinkSync(outside,documents+'/.messenger-inputs');}return originalMkdir(path,options);};syncBuiltinESMExports();
try{await assert.rejects(()=>handoff({...mapping,uploads:[{id:'fenced-upload',name:'sample.txt',mimeType:'text/plain',size:4,sha256:createHash('sha256').update('test').digest('hex'),key:'staging/uploads/fenced-upload/content',url:'https://account.r2.cloudflarestorage.com/bucket/staging/uploads/fenced-upload/content?signature=private'}]}));assert.ok(swapped);}finally{fs.promises.mkdir=originalMkdir;syncBuiltinESMExports();}
assert.deepEqual(await fs.promises.readdir(outside),[]);await rm(documents+'/.messenger-inputs');renameSync(documents+'/.messenger-inputs-moved',documents+'/.messenger-inputs');
console.log(JSON.stringify({passed:true,firstImportNativeWrite:true,existingMetadataPreserved:true,protectedInputsUnchanged:true,symlinkAndWorkspaceSwapRejected:true,creationRacePreserved:true,retainedLeaseBlocksExternalWrites:true}));
`;
test('first import preserves native document writes without changing existing metadata or protected inputs', () => {
  const output = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--entrypoint',
      'node',
      '--env',
      `HELPER_TOKEN=${'h'.repeat(32)}`,
      '--env',
      `GATEWAY_TOKEN=${'g'.repeat(32)}`,
      '--env',
      'R2_ORIGIN=https://account.r2.cloudflarestorage.com',
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
  assert.equal(JSON.parse(output.trim()).passed, true);
});
