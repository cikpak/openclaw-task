import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
if (!process.env.OPENCLAW_TEST_IMAGE)
  throw new Error('Select the pinned helper image');
const script = `
import assert from 'node:assert/strict';
import { mkdir,readFile,writeFile,unlink } from 'node:fs/promises';
import { createHash,randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { unlinkSync, symlinkSync, renameSync } from 'node:fs';
import { environment } from './environment.mjs';
import { initialize } from './configuration.mjs';
import { handoff } from './files-handoff.mjs';
import { pdfReadFiles } from './pdf-input.mjs';
import { currentConfig } from './pdf-files.mjs';
function makePdf(text) {
 const stream=deflateSync(Buffer.from(text === null ? '1 0 0 rg 10 10 100 100 re f' : 'BT /F1 18 Tf 36 750 Td ('+text+') Tj ET'));
 const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),Buffer.concat([Buffer.from('<< /Length '+stream.length+' /Filter /FlateDecode >>\\nstream\\n'),stream,Buffer.from('\\nendstream')])];
 const chunks=[Buffer.from('%PDF-1.7\\n')],offsets=[0];let size=chunks[0].length;
 for(const [index,object] of objects.entries()){offsets.push(size);const chunk=Buffer.concat([Buffer.from((index+1)+' 0 obj\\n'),object,Buffer.from('\\nendobj\\n')]);chunks.push(chunk);size+=chunk.length;}
 chunks.push(Buffer.from('xref\\n0 6\\n0000000000 65535 f \\n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \\n').join('')+'trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n'+size+'\\n%%EOF\\n'));return Buffer.concat(chunks);
}
environment();await mkdir('/recovery',{recursive:true});
const key=randomBytes(32),publicKey=key.toString('base64url');
const identity={deviceId:createHash('sha256').update(key).digest('hex'),publicKey,role:'operator',scopes:['operator.admin','operator.read','operator.write']};
process.env.EXPECTED_MANAGER_DEVICE_ID=identity.deviceId;process.env.EXPECTED_MANAGER_PUBLIC_KEY=publicKey;
await initialize({identity});
const originals=[makePdf('COMPRESSED_PDF_REAL_READ_MARKER '+ 'Readable content '.repeat(20)),makePdf(null)];
assert.equal(originals[0].includes(Buffer.from('COMPRESSED_PDF_REAL_READ_MARKER')),false);
const uploads=originals.map((bytes,index)=>({id:'pdf'+index,name:'source-'+index+'.pdf',mimeType:'application/pdf',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),key:'staging/uploads/pdf'+index+'/content',url:'https://account.r2.cloudflarestorage.com/bucket/staging/uploads/pdf'+index+'/content?signature=private'}));
globalThis.fetch=async(url)=>new Response(originals[url.includes('/pdf0/')?0:1]);
const data={agentId:'main',sessionKey:'agent:main:main',uploads};
const first=await handoff(data);assert.equal(first.uploads.length,2);
for(const [index,file]of first.uploads.entries())assert.deepEqual(await readFile(file.path),originals[index]);
const text=first.uploads[0].readFiles.find(file=>file.mimeType==='text/plain');
const page=first.uploads[1].readFiles.find(file=>file.mimeType==='image/png');assert.ok(text);assert.ok(page);
const { f:createReadTool }=await import('/app/dist/tools-ByVn7L4O.mjs');
const { r:createOpenClawReadTool }=await import('/app/dist/agent-tools.read-ROC0dTSe.mjs');
const tool=createOpenClawReadTool(createReadTool('/recovery/workspace'),{cwd:'/recovery/workspace'});
const read=await tool.execute('read-pdf-text',{path:text.path},new AbortController().signal);
assert.ok(read.content.some(part=>part.type==='text' && part.text.includes('COMPRESSED_PDF_REAL_READ_MARKER')));
const image=await tool.execute('read-pdf-page',{path:page.path},new AbortController().signal);
assert.ok(image.content.some(part=>part.type==='image' && part.mimeType==='image/png'));
assert.throws(()=>childProcess.execFileSync(process.execPath,['-e','require("fs").appendFileSync(process.argv[1],"changed")',text.path],{uid:1000,gid:1000,stdio:'ignore'}));
assert.ok(childProcess.execFileSync(process.execPath,['-e','process.stdout.write(require("fs").readFileSync(process.argv[1]))',text.path],{uid:1000,gid:1000,encoding:'utf8'}).includes('COMPRESSED_PDF_REAL_READ_MARKER'));

assert.deepEqual(await handoff(data),first);
await writeFile(text.path,'tampered derivative');await assert.rejects(()=>handoff(data));
await unlink(text.path);await assert.rejects(()=>handoff(data));
const corrupt=first.uploads[0].path.replace('source-0.pdf','corrupt.pdf');await writeFile(corrupt,'%PDF-corrupt');
await assert.rejects(()=>pdfReadFiles(corrupt,corrupt.slice(0,corrupt.lastIndexOf('/')),AbortSignal.timeout(10000)));
const credentialMarker='private-plugin-credential-'+randomBytes(32).toString('hex');
const privateConfig=JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH,'utf8'));privateConfig.plugins={entries:{'document-extract':{enabled:true,config:{apiKey:credentialMarker}},unrelated:{config:{secret:credentialMarker}}},load:{paths:[credentialMarker]}};await writeFile(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(privateConfig));
assert.deepEqual(await currentConfig(),{entries:{'document-extract':{enabled:true}}});
const realSpawn=childProcess.spawn;
async function attack(name, mutate) {
 const path=first.uploads[0].path.replace('source-0.pdf',name+'.pdf');await writeFile(path,makePdf(name+' '+ 'safe content '.repeat(25)));
 let spawned=false;
 childProcess.spawn=(command,args,options)=>{if(args[0].endsWith('pdf-worker.mjs')){spawned=true;assert.equal(options.uid,1000);assert.equal(options.gid,1000);for(const key of ['HELPER_TOKEN','GATEWAY_TOKEN','OPENAI_API_KEY','R2_SECRET_ACCESS_KEY'])assert.equal(options.env[key],undefined);mutate(path);}const child=realSpawn(command,args,options);const end=child.stdin.end.bind(child.stdin);child.stdin.end=(input,...rest)=>{assert.equal(String(input).includes(credentialMarker),false);return end(input,...rest);};return child;};syncBuiltinESMExports();
 try { await assert.rejects(()=>pdfReadFiles(path,path.slice(0,path.lastIndexOf('/')),AbortSignal.timeout(20000)));assert.ok(spawned); }
 finally {childProcess.spawn=realSpawn;syncBuiltinESMExports();}
}
const victim=first.uploads[0].path.replace('source-0.pdf','victim.txt');await writeFile(victim,'untouched private file');
await attack('source-swap',path=>{unlinkSync(path);symlinkSync(victim,path);});assert.equal(await readFile(victim,'utf8'),'untouched private file');
const uploadDirectory=first.uploads[0].path.slice(0,first.uploads[0].path.lastIndexOf('/'));
await attack('ancestor-swap',()=>renameSync(uploadDirectory,uploadDirectory+'-moved'));renameSync(uploadDirectory+'-moved',uploadDirectory);
privateConfig.plugins={enabled:false,allow:['other-secret-plugin'],deny:['DOCUMENT-EXTRACT'],entries:{'DOCUMENT-EXTRACT':{enabled:false,config:{token:credentialMarker}}}};await writeFile(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(privateConfig));
assert.deepEqual(await currentConfig(),{enabled:false,allow:['messenger-unrelated-plugin'],deny:['document-extract'],entries:{'document-extract':{enabled:false}}});
const config=JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH,'utf8'));config.plugins={entries:{'document-extract':{enabled:false}}};await writeFile(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(config));
const disabled=first.uploads[0].path.replace('source-0.pdf','disabled.pdf');await writeFile(disabled,makePdf('DISABLED_PLUGIN_DIFFERENT_PDF '+ 'words '.repeat(100)));
await assert.rejects(()=>pdfReadFiles(disabled,disabled.slice(0,disabled.lastIndexOf('/')),AbortSignal.timeout(10000)));
console.log(JSON.stringify({passed:true,compressedTextRead:true,imageOnlyPageRead:true,originalsUnchanged:true,retryVerified:true,corruptionAndDisabledRejected:true}));
`;
test('pinned PDF extraction provides native-readable private companions and preserves exact originals', () => {
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
      timeout: 180_000,
    },
  );
  assert.equal(JSON.parse(output.trim()).passed, true);
});
