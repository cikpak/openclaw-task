import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
if (!process.env.OPENCLAW_TEST_IMAGE)
  throw new Error(
    'Run pnpm test:engine or select OPENCLAW_TEST_IMAGE explicitly',
  );
// Run inside the pinned image: filesystem /proc behavior is Linux, with only signed GET mocked.
const script = `
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { randomBytes,createHash } from 'node:crypto';
import { environment } from './environment.mjs';
import { initialize } from './configuration.mjs';
import { handoff } from './files-handoff.mjs';
import { openInput } from './files-input.mjs';
import { inputMetadata } from './files.mjs';
environment(); const key=randomBytes(32),publicKey=key.toString('base64url');
const identity={deviceId:createHash('sha256').update(key).digest('hex'),publicKey,role:'operator',scopes:['operator.admin','operator.read','operator.write']};
process.env.EXPECTED_MANAGER_DEVICE_ID=identity.deviceId;process.env.EXPECTED_MANAGER_PUBLIC_KEY=publicKey;
await mkdir('/recovery',{recursive:true});await initialize({identity});
const data={agentId:'main',sessionKey:'agent:main:main',uploads:[{id:'input123',name:'sample.txt',mimeType:'text/plain',size:4,sha256:createHash('sha256').update('test').digest('hex'),key:'staging/uploads/input123/content',url:'https://account.r2.cloudflarestorage.com/bucket/staging/uploads/input123/content?signature=private'}]};
let gets=0;globalThis.fetch=async()=>{gets++;return new Response('test')};
const result=await handoff(data);const path=result.uploads[0].path;
assert.ok(path.includes('/documents/.messenger-inputs/'));assert.equal(await readFile(path,'utf8'),'test');
await writeFile(path,'new current input');
assert.deepEqual(await handoff(data),result);assert.equal(gets,1);assert.equal(await readFile(path,'utf8'),'new current input');
const input=await openInput({...data,id:'input123'});let text='';for await(const chunk of input.handle.createReadStream({autoClose:false}))text+=chunk;await input.handle.close();assert.equal(text,'new current input');
const knownDeviceToken='native-device-fixture-'+randomBytes(32).toString('hex');
await writeFile(path,knownDeviceToken);await assert.rejects(()=>inputMetadata({...data,id:'input123',secrets:[knownDeviceToken]}));
await writeFile(path,'new current input');assert.equal((await inputMetadata({...data,id:'input123',secrets:[knownDeviceToken]})).digest,createHash('sha256').update('new current input').digest('hex'));
await unlink(path);await assert.rejects(()=>handoff(data));assert.equal(gets,1);
await assert.rejects(()=>handoff({...data,uploads:[{...data.uploads[0],id:'other',url:'https://evil.test/bucket/staging/uploads/input123/content'}]}));
await assert.rejects(()=>handoff({...data,uploads:[{...data.uploads[0],id:'other',sha256:'0'.repeat(64)}]}));

const { f:createReadTool }=await import('/app/dist/tools-ByVn7L4O.mjs');
const { r:createOpenClawReadTool }=await import('/app/dist/agent-tools.read-ROC0dTSe.mjs');
const png='/recovery/workspace/documents/pixel.png';
await writeFile(png,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5c8AAAAASUVORK5CYII=','base64'));
const tool=createOpenClawReadTool(createReadTool('/recovery/workspace'),{cwd:'/recovery/workspace'});
const read=await tool.execute('read-image',{path:png},new AbortController().signal);
assert.ok(read.content.some(part=>part.type==='image' && part.mimeType==='image/png' && part.data.length>0));
console.log(JSON.stringify({passed:true,signedGetOnly:true,stableRetryPreservesCurrent:true,missingCurrentFailsClosed:true,shaMismatchRejected:true}));
`;
test('pinned-image signed upload handoff is stable, bounded and current', () => {
  const output = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      '--env',
      'HELPER_TOKEN=' + 'h'.repeat(32),
      '--env',
      'GATEWAY_TOKEN=' + 'g'.repeat(32),
      '--env',
      'R2_ORIGIN=https://account.r2.cloudflarestorage.com',
      process.env.OPENCLAW_TEST_IMAGE,
      '--input-type=module',
      '-e',
      script,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  assert.equal(JSON.parse(output.trim()).passed, true);
});
