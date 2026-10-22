/** Executed as native UID1000 from the immutable image; exact native custody spans reset. */
export const resetSource = `
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {t as create} from '/app/dist/user-turn-transcript-DkAE8Np5.mjs';
import {loadGatewaySessionEntry,loadGatewaySessionEntryReadOnly} from '/app/dist/session-utils-store-DT1w1HJu.mjs';
import {i as prepareQualifiedSessionEntryTarget} from '/app/dist/session-accessor.entry--ex-1zkg.mjs';
const mapping=JSON.parse(process.argv[1]);
const config=JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
const load=()=>loadGatewaySessionEntryReadOnly(mapping.sessionKey,{agentId:mapping.agentId},config);
const admitted=loadGatewaySessionEntry(mapping.sessionKey,{agentId:mapping.agentId},config);
const scope={id:admitted.entry.sessionId,revision:admitted.entry.lifecycleRevision,storePath:admitted.storePath,key:admitted.canonicalKey};
const qualified=prepareQualifiedSessionEntryTarget({...admitted,canonicalKey:admitted.canonicalKey,requestedKey:mapping.sessionKey,storeKey:admitted.legacyKey??admitted.canonicalKey,readSource:admitted.capturedReadSource},admitted.capturedReadSources);
const assertCurrent=()=>{qualified.assertCurrent();const current=load();assert.equal(current.storePath,scope.storePath);assert.equal(current.canonicalKey,scope.key);assert.equal(current.entry.sessionId,scope.id);assert.equal(current.entry.lifecycleRevision,scope.revision);};
const target=()=>{assertCurrent();const current=load();return {...mapping,sessionKey:qualified.target.storeKey,agentId:qualified.target.agentId,sessionId:scope.id,expectedSessionId:scope.id,sessionEntry:current.entry,sessionStore:current.store,storePath:qualified.target.storePath,config};};
const message={role:'user',idempotencyKey:randomUUID()+':user',content:'Physical lifecycle fence',__openclaw:{transport:{clients:[{id:'gateway-client',mode:'cli',displayName:'Messenger manager'}]}}};
const record=create({message,target,onPersistenceError(){}});
try {
 await record.resolveMessage();
 assert.equal(await record.stageApproved({runId:message.idempotencyKey.slice(0,-5),assertCurrent,assertAdmittedCurrent:assertCurrent}),true);
 await record.withPendingInput(async()=>{await record.confirmMessengerProcessingForPersistence('generation-owner');await record.persistApproved();await record.waitForRuntimePersistence();record.assertMessengerProcessingCommitted();});
 emit({phase:'ready',scope:scope.id,revision:scope.revision});
 await new Promise(resolve=>process.stdin.once('data',resolve));
 const after=load();
 assert.equal(after.entry.sessionId,scope.id);
 assert.notEqual(after.entry.lifecycleRevision,scope.revision);
 let providers=0,rejected=false;
 try {
  await record.withPendingInput(async()=>{await record.confirmMessengerProcessingForPersistence('after-reset-owner');await record.waitForRuntimePersistence();record.assertMessengerProcessingCommitted();providers++;});
 } catch {rejected=true;}
 assert.equal(rejected,true);assert.equal(providers,0);
 emit({phase:'done',uid:process.getuid(),physicalLifecycleRevisionChanged:true,staleCustodyRejected:true,providerCalls:providers});
} finally {
 try {record.finishPendingInput('interrupted');await record.waitForPendingInputSettlement();}
 finally {await qualified.release();}
}
`;
