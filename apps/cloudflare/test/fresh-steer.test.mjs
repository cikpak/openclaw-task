import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Production admission, SQLite store, claim/dispatch and service reconstruction;
// only native transport is deterministic, and execution is held until resume.
const script = (
  await build({
    stdin: {
      contents: `
import {DurableObject} from 'cloudflare:workers';
import {DurableObjectStore} from '../backend/src/storage/durable-object.ts';
import {ChatService,mapping} from '../backend/src/chats/service.ts';
import {FakeGateway,testSettings} from '../backend/test/fake-gateway.ts';
import {ManagerApplication} from './src/manager/application.ts';
import {ManagerAuthorization} from './src/manager/authorization.ts';
const grant={id:'grant',sessionId:'session',accountId:'owner',managerId:'primary',expiresAt:4102444800000};
export class Probe extends DurableObject {
 constructor(ctx,env){
  super(ctx,env);this.store=new DurableObjectStore(ctx.storage);
  this.gateway=new FakeGateway();this.calls=[];
  const send=this.gateway.send.bind(this.gateway);
  this.gateway.send=(...args)=>{this.calls.push({id:args[1],behavior:args[3]});return send(...args);};
  this.service=new ChatService(this.store,this.gateway,undefined,{backgroundReconciliation:false});
  this.authorization=new ManagerAuthorization(env,this.store);
  const engine={service:this.service,gateway:this.gateway,wake:()=>Promise.resolve(),tick:()=>Promise.resolve(),deadline:()=>null};
  this.application=new ManagerApplication(this.store,this.authorization,engine,job=>void job.catch(()=>{}));
 }
 async fetch(request){
  const input=await request.json();
  if(input.action==='initialize'){
   const chat=await this.service.create({commandId:crypto.randomUUID(),settings:testSettings});
   await this.service.drain();this.authorization.claim('chat',chat.id,'owner');
   const target=mapping(this.store.getChat(chat.id));const parent=crypto.randomUUID();
   const history=this.gateway.histories.get(target.sessionKey);
   history.activeRun={id:parent,text:'',sequence:0};
   await this.service.reconcile();await this.service.drain();
   await this.ctx.storage.put('nativeFixture',{chatId:chat.id,parent,target,history});
   return Response.json({chatId:chat.id,parent});
  }
  if(input.action==='resume'){
   const fixture=await this.ctx.storage.get('nativeFixture');
   if(input.active==='different')fixture.history.activeRun.id=crypto.randomUUID();
   if(input.active==='idle')fixture.history.activeRun=null;
   this.gateway.histories.set(fixture.target.sessionKey,fixture.history);
   await this.service.reconcile();await this.service.drain();
   return Response.json({calls:this.calls,pending:this.store.pending(fixture.chatId)});
  }
  if(input.action==='close'){this.service.close();await this.service.drain();return Response.json({});}
  const result=await this.application.transport(grant).dispatch(input.command,'probe');
  return Response.json({result,calls:this.calls,intents:this.store.db.prepare('SELECT * FROM pending_steer_intents').all()});
 }
}
export default {fetch(request,env){return env.PROBE.getByName('primary').fetch(request);}};
export const auth={fetch(){return Response.json({grant});}};
`,
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

function runtime(path) {
  return new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: path,
      workers: [
        {
          name: 'probe',
          modules: true,
          script,
          compatibilityDate: '2026-10-22',
          compatibilityFlags: ['nodejs_compat'],
          serviceBindings: { BACKEND: 'auth' },
          durableObjects: { PROBE: { className: 'Probe', useSQLite: true } },
        },
        {
          name: 'auth',
          modules: true,
          script: `const grant={id:'grant',sessionId:'session',accountId:'owner',managerId:'primary',expiresAt:4102444800000};export default{fetch(){return Response.json({grant});}};`,
          compatibilityDate: '2026-10-22',
        },
      ],
    }),
  );
}
async function send(mf, input) {
  const response = await mf.dispatchFetch('https://probe/', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}
test('actual manager admission preserves the exact steer target over full workerd restart before dispatch', async () => {
  const path = await mkdtemp(join(tmpdir(), 'messenger-fresh-steer-'));
  let mf = runtime(path);
  try {
    const fixture = await send(mf, { action: 'initialize' });
    const command = {
      type: 'conversation.message.send',
      commandId: randomUUID(),
      chatId: fixture.chatId,
      text: 'Fresh durable steer',
      behavior: 'steer',
    };
    const accepted = await send(mf, { command });
    assert.equal(accepted.result.ok, true, JSON.stringify(accepted));
    assert.equal(accepted.result.data.receipt.state, 'accepted');
    assert.deepEqual(accepted.calls, []);
    assert.equal(accepted.intents[0].target_run_id, fixture.parent);
    await send(mf, { action: 'close' });
    await mf.dispose();
    mf = runtime(path);
    const resumed = await send(mf, { action: 'resume' });
    assert.deepEqual(resumed.calls, [
      { id: command.commandId, behavior: 'steer' },
    ]);
    assert.equal(resumed.pending[0].state, 'submitted');
    const replay = await send(mf, { command });
    assert.deepEqual(replay.result, accepted.result);
    assert.deepEqual(replay.intents, []);
    assert.equal((await send(mf, { action: 'resume' })).calls.length, 1);
  } finally {
    await send(mf, { action: 'close' }).catch(() => {});
    await mf.dispose();
    await rm(path, { recursive: true, force: true });
  }
});
test('a different recovered run never inherits an old fresh-steer target; idle falls back to queue', async () => {
  const path = await mkdtemp(join(tmpdir(), 'messenger-fresh-target-'));
  let mf = runtime(path);
  try {
    const fixture = await send(mf, { action: 'initialize' });
    const command = {
      type: 'conversation.message.send',
      commandId: randomUUID(),
      chatId: fixture.chatId,
      text: 'Only steer original',
      behavior: 'steer',
    };
    const accepted = await send(mf, { command });
    assert.equal(accepted.result.ok, true, JSON.stringify(accepted));
    await send(mf, { action: 'close' });
    await mf.dispose();
    mf = runtime(path);
    const different = await send(mf, { action: 'resume', active: 'different' });
    assert.deepEqual(different.calls, []);
    assert.equal(different.pending[0].state, 'pending');
    const idle = await send(mf, { action: 'resume', active: 'idle' });
    assert.deepEqual(idle.calls, [
      { id: command.commandId, behavior: 'queue' },
    ]);
  } finally {
    await send(mf, { action: 'close' }).catch(() => {});
    await mf.dispose();
    await rm(path, { recursive: true, force: true });
  }
});
