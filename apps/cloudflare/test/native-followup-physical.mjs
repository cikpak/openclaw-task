import assert from 'node:assert/strict';
/** Native imports execute from baked /app; physical SQLite and custody are never mocked. */
export async function physical(f, mapping) {
  const value = await f.node(
    `
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {t as create} from '/app/dist/user-turn-transcript-DkAE8Np5.mjs';
import {loadGatewaySessionEntry,loadGatewaySessionEntryReadOnly} from '/app/dist/session-utils-store-DT1w1HJu.mjs';
import {i as prepareQualifiedSessionEntryTarget} from '/app/dist/session-accessor.entry--ex-1zkg.mjs';
import {readSessionMessageByIdAsync} from '/app/dist/session-transcript-readers-C__bw85l.mjs';
const mapping=JSON.parse(process.argv[1]);
const config=JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
const load=()=>loadGatewaySessionEntryReadOnly(mapping.sessionKey,{agentId:mapping.agentId},config);
const admitted=loadGatewaySessionEntry(mapping.sessionKey,{agentId:mapping.agentId},config);
const admittedScope={storePath:admitted.storePath,key:admitted.canonicalKey,id:admitted.entry.sessionId,revision:admitted.entry.lifecycleRevision};
const qualified=prepareQualifiedSessionEntryTarget({...admitted,canonicalKey:admitted.canonicalKey,requestedKey:mapping.sessionKey,storeKey:admitted.legacyKey??admitted.canonicalKey,readSource:admitted.capturedReadSource},admitted.capturedReadSources);
const recorders=[];
try {
const assertCurrent=()=>{qualified.assertCurrent();const current=load();assert.equal(current.storePath,admittedScope.storePath);assert.equal(current.canonicalKey,admittedScope.key);assert.equal(current.entry.sessionId,admittedScope.id);assert.equal(current.entry.lifecycleRevision,admittedScope.revision);};
const custody=runId=>({runId,assertCurrent,assertAdmittedCurrent:assertCurrent});
const target=()=>{assertCurrent();return {...mapping,sessionKey:qualified.target.storeKey,agentId:qualified.target.agentId,sessionId:admittedScope.id,expectedSessionId:admittedScope.id,storePath:qualified.target.storePath,config};};
const input=()=>({role:'user',idempotencyKey:randomUUID()+':user',content:'Physical native custody fixture',__openclaw:{transport:{clients:[{id:'gateway-client',mode:'cli',displayName:'Messenger manager'}]}}});
const recorder=(message,extra={})=>{const record=create({message,target,onPersistenceError(){},...extra});recorders.push(record);return record;};
let providers=0;
const provider=record=>{record.assertMessengerProcessingCommitted();providers++;};
const stagedMessage=input(),staged=recorder(stagedMessage);await staged.resolveMessage();
assert.equal(await staged.stageApproved(custody(stagedMessage.idempotencyKey.slice(0,-5))),true);
const approved=structuredClone(staged.getPendingInputMessage());
await staged.confirmMessengerProcessingForPersistence('staged-owner');
assert.deepEqual(staged.getPendingInputMessage(),approved);
assert.throws(()=>provider(staged));assert.equal(providers,0);
await staged.withPendingInput(async()=>{await staged.persistApproved();await staged.waitForRuntimePersistence();provider(staged);});
const admission=staged.getAdmissionReceipt();assert.ok(admission?.entryId);
const found=await readSessionMessageByIdAsync(target(),admission.entryId,{currentOnly:true,readOnly:true});
assert.equal(found.found,true);assert.equal(found.message.__openclaw.messengerProcessing.runId,'staged-owner');
for(const count of [2,65]){
 const sources=Array.from({length:count},()=>recorder(input()));
 for(const source of sources){await source.resolveMessage();assert.equal(await source.stageApproved(custody(source.message.idempotencyKey.slice(0,-5))),true);}
 const expected=sources.map(source=>source.getPendingInputMessage().idempotencyKey);
 const group=recorder(input(),{pendingInputSources:sources});await group.resolveMessage();
 await group.withPendingInput(async()=>{await group.confirmMessengerProcessingForPersistence('group-'+count);await group.persistApproved();await group.waitForRuntimePersistence();provider(group);});
 const result=await readSessionMessageByIdAsync(target(),group.getAdmissionReceipt().entryId,{currentOnly:true,readOnly:true});
 assert.equal(result.found,true);assert.deepEqual(result.message.__openclaw.messengerProcessing.keys,expected);
 assert.equal(result.message.__openclaw.messengerProcessing.runId,'group-'+count);
}
const mixedStaged=recorder(input());await mixedStaged.resolveMessage();await mixedStaged.stageApproved(custody(mixedStaged.message.idempotencyKey.slice(0,-5)));
const mixed=recorder(input(),{pendingInputSources:[mixedStaged,recorder(input())]});
await assert.rejects(()=>mixed.resolveMessage(),/mix staged and unstaged/);
const failing=recorder(input(),{beforeMessageWrite(){throw new Error('fixture canonical commit denied');}});
await failing.resolveMessage();await failing.confirmMessengerProcessingForPersistence('never-provider');
await assert.rejects(()=>failing.persistApproved());assert.throws(()=>provider(failing));
const blocked=recorder(input());await blocked.resolveMessage();blocked.markBlocked();
await assert.rejects(()=>blocked.confirmMessengerProcessingForPersistence('blocked-owner'));assert.equal(providers,3);
emit({uid:process.getuid(),providers,stagedPhysicalCommit:true,approvedBytesUnchanged:true,groupedPhysicalSources:2,overflowPhysicalSources:65,mixedCustodyRejected:true,failedCanonicalCommitNoProvider:true,blockedNoProvider:true});
} finally {
 try {
  const settled=await Promise.allSettled(recorders.map(async record=>{record.finishPendingInput('interrupted');await record.waitForPendingInputSettlement();}));
  const failed=settled.filter(result=>result.status==='rejected');if(failed.length)throw new Error('Native custody cleanup failed');
 } finally {await qualified.release();}
}
`,
    [JSON.stringify(mapping)],
  );
  assert.equal(value.uid, 1000);
  assert.equal(value.providers, 3);
  return value;
}
