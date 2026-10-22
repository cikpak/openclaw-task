import assert from 'node:assert/strict';
/** Read the physical canonical native row as UID1000, independently of SDK projection. */
export async function canonical(f, mapping) {
  const page = await f.gateway.request('chat.history', {
    ...mapping,
    limit: 200,
    maxBytes: 2_097_152,
  });
  const ids = page.messages
    .map((message) => message.__openclaw?.id)
    .filter((id) => id && !id.startsWith('pending:'));
  const value = await f.node(
    `
import {readFile} from 'node:fs/promises';
import {loadGatewaySessionEntryReadOnly} from '/app/dist/session-utils-store-DT1w1HJu.mjs';
import {readSessionMessageByIdAsync} from '/app/dist/session-transcript-readers-C__bw85l.mjs';
const {mapping,ids}=JSON.parse(process.argv[1]);
const cfg=JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
const selected=loadGatewaySessionEntryReadOnly(mapping.sessionKey,{agentId:mapping.agentId},cfg);
const target={...mapping,sessionId:selected.entry.sessionId,sessionEntry:selected.entry,storePath:selected.storePath};
const rows=[];
for(const id of ids){
 const result=await readSessionMessageByIdAsync(target,id,{allowResetArchiveFallback:false,currentOnly:true,readOnly:true});
 if(!result.found||result.oversized)throw new Error('Canonical row unavailable');
 const m=result.message; rows.push({id,role:m.role,key:m.idempotencyKey,meta:m.__openclaw,stopReason:m.stopReason,channel:m.channel});
}
const after=loadGatewaySessionEntryReadOnly(mapping.sessionKey,{agentId:mapping.agentId},cfg);
if(after.entry.sessionId!==target.sessionId||after.entry.lifecycleRevision!==selected.entry.lifecycleRevision)throw new Error('Physical native scope changed');
emit({scope:target.sessionId,rows,uid:process.getuid()});
`,
    [JSON.stringify({ mapping, ids })],
  );
  assert.equal(value.uid, 1000);
  return { ...value, page };
}
