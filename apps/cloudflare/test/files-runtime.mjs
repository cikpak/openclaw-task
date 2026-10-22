import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { scryptSync } from 'node:crypto';
import { origin } from './runtime.mjs';
export async function filesRuntime() {
  async function bundle(input) {
    const result = await build({
      ...(typeof input === 'string'
        ? { entryPoints: [input] }
        : {
            stdin: {
              contents: input.source,
              resolveDir: process.cwd(),
              loader: 'ts',
            },
          }),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      external: ['node:*', 'cloudflare:*'],
      write: false,
    });
    return result.outputFiles[0].text;
  }
  const probe = await bundle({
    source: `
import {DurableObject} from 'cloudflare:workers';
import {DurableObjectStore} from '../backend/src/storage/durable-object.ts';
import {ManagerAuthorization} from './src/manager/authorization.ts';
import {ManagerFiles} from './src/files/service.ts';
export class FilesProbe extends DurableObject {
 constructor(ctx,env) {super(ctx,env);this.store=new DurableObjectStore(ctx.storage);this.auth=new ManagerAuthorization(env,this.store);this.files=new ManagerFiles({store:this.store,env,state:ctx,schedule:{set:(_name,deadline)=>deadline===null?ctx.storage.deleteAlarm():ctx.storage.setAlarm(deadline)}},this.auth);}
 async fetch(request) {
  const path=new URL(request.url).pathname;
  if(path.startsWith('/downloads/'))return this.files.download(request);
  if(path==='/internal/revoke')return new Response(null,{status:204});
  const input=await request.json();
  if(path==='/test/seed') {
   const bytes=new Uint8Array(input.size).fill(97),grant=input.grant;
   const {uploadId}=await this.files.command({type:'upload.begin',commandId:crypto.randomUUID(),name:'safe-input.txt',mimeType:'text/plain',size:bytes.length},grant);
   for(let offset=0;offset<bytes.length;offset+=48*1024) {
    const base64=btoa(Array.from(bytes.subarray(offset,offset+48*1024),byte=>String.fromCharCode(byte)).join(''));
    await this.files.command({type:'upload.chunk',commandId:crypto.randomUUID(),uploadId,offset,base64},grant);
   }
   await this.files.command({type:'upload.complete',commandId:crypto.randomUUID(),uploadId},grant);
   const chatId=crypto.randomUUID(),settings={model:'test/model',thinkingLevel:'off',fastMode:false};
   this.store.reserveChat({id:chatId,name:'Test chat',status:'idle',version:1,createdAt:Date.now(),updatedAt:Date.now(),unread:false,settings,agentId:null,sessionKey:null,creationId:crypto.randomUUID()});
   this.auth.claim('chat',chatId,grant.accountId);
   this.files.uploads.commitReferences({type:'conversation.message.send',commandId:crypto.randomUUID(),chatId,text:'Input',uploadIds:[uploadId]},chatId,grant.accountId);
   return Response.json({fileId:uploadId,chatId});
  }
  if(path==='/test/private-input') {
   const upload=this.files.uploads.lookup(input.fileId),chat=this.store.getChat(input.chatId);
   chat.agentId='native-test-agent';chat.sessionKey='native-test-session';this.store.saveChat(chat);
   const nativePath='/recovery/workspace/documents/.messenger-inputs/session/'+input.fileId+'/safe-input.txt';
   this.files.recordInputPath(input.fileId,nativePath);
   const privateBytes=new TextEncoder().encode('Private account configuration '+this.env.R2_SECRET_ACCESS_KEY);
   const digest=Buffer.from(await crypto.subtle.digest('SHA-256',privateBytes)).toString('hex');
   const key='files/private-input-generation/'+digest;
   await this.env.RECOVERY_BUCKET.put(key,privateBytes);
   const archiveBytes=new TextEncoder().encode('private-recovery-state');
   const archiveHash=Buffer.from(await crypto.subtle.digest('SHA-256',archiveBytes)).toString('hex');
   const archive={key:'recovery/private-input-generation/internal.tar.gz',size:archiveBytes.length,sha256:archiveHash,md5:'YWFhYWFhYWFhYWFhYWFhYQ=='};
   const manifest={...archive,key:'recovery/private-input-generation/manifest.json'};
   await this.env.RECOVERY_BUCKET.put(archive.key,archiveBytes);await this.env.RECOVERY_BUCKET.put(manifest.key,archiveBytes);
   const descriptor={version:1,checkpointId:'private-input-generation',archive,manifest,files:[{key,path:nativePath.slice('/recovery/'.length),size:privateBytes.length,sha256:digest,md5:'YWFhYWFhYWFhYWFhYWFhYQ==',mode:384,uid:1000,gid:1000}],inventoryDigest:digest,counts:{entries:1,userFiles:1,databases:0}};
   await this.files.inputs.audit(()=>Promise.reject(new Error('Known secret found')));
   this.files.commit(descriptor);
   const publication=this.files.inputs.get(input.fileId),source=this.store.db.prepare('SELECT object_key FROM input_file_paths WHERE id=?').get(input.fileId);
   const preserved=await this.env.RECOVERY_BUCKET.get(key);
   return Response.json({originalPresent:!!(await this.env.RECOVERY_BUCKET.head(upload.key)),privatePresent:!!preserved,privateDigest:preserved?Buffer.from(await crypto.subtle.digest('SHA-256',await preserved.arrayBuffer())).toString('hex'):null,expectedDigest:digest,eligible:publication.eligible,committedSource:source.object_key,engineAbsent:!this.ctx.container});
  }
  if(path==='/test/stats')return Response.json({readers:this.store.db.prepare('SELECT count(*) AS count FROM file_readers').get().count,live:this.files.readers.live(),pinned:[...this.files.readers.keys()]});
  if(path==='/test/resolve') return Response.json(await this.files.command({type:'files.resolve',commandId:crypto.randomUUID(),chatId:input.chatId,fileId:input.fileId},input.grant));
  return new Response(null,{status:404});
 }
}
export default {fetch(request,env){return env.FILES.getByName('primary').fetch(request);}};`,
  });
  const common = {
    modules: true,
    compatibilityDate: '2026-10-22',
    compatibilityFlags: ['nodejs_compat'],
  };
  const salt = 'b640963416b41c4eaa7002ed39c35492';
  const hash = `scrypt$${salt}$${scryptSync('runtime-password', Buffer.from(salt, 'hex'), 64).toString('hex')}`;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          ...common,
          name: 'facade',
          script: await bundle('src/facade.ts'),
          serviceBindings: { BACKEND: 'backend', MANAGER: 'files' },
        },
        {
          ...common,
          name: 'backend',
          script: await bundle('src/auth/worker.ts'),
          d1Databases: { AUTH_DB: 'auth' },
          serviceBindings: { MANAGER: 'files' },
          bindings: {
            APP_ORIGIN: origin,
            APP_USERNAME: 'owner',
            APP_PASSWORD_HASH: hash,
            SESSION_TTL_SECONDS: '86400',
          },
        },
        {
          ...common,
          name: 'files',
          script: probe,
          serviceBindings: { BACKEND: 'backend' },
          r2Buckets: { RECOVERY_BUCKET: 'input-objects' },
          durableObjects: {
            FILES: { className: 'FilesProbe', useSQLite: true },
          },
          bindings: {
            APP_ORIGIN: origin,
            MANAGER_ID: 'primary',
            R2_SECRET_ACCESS_KEY: 'preserved-known-account-secret',
          },
        },
      ],
    }),
  );
  const db = await mf.getD1Database('AUTH_DB', 'backend');
  const sql = await readFile(
    new URL('../migrations/0001_auth.sql', import.meta.url),
    'utf8',
  );
  for (const statement of sql
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean))
    await db.prepare(statement).run();
  const backend = await mf.getWorker('backend'),
    files = await mf.getWorker('files');
  return {
    mf,
    db,
    public: (path, options = {}) =>
      mf.dispatchFetch(`${origin}${path}`, options),
    private: (path, value) =>
      backend.fetch(`https://backend${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      }),
    probe: async (path, value = {}) => {
      const response = await files.fetch(`https://files/test/${path}`, {
        method: 'POST',
        body: JSON.stringify(value),
      });
      if (!response.ok)
        throw new Error(
          `Probe failed: ${response.status} ${await response.text()}`,
        );
      return response.json();
    },
  };
}
