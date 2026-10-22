import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  frameSource,
  nextResult,
  retainOutput,
} from './native-followup-output.mjs';
import { resetSource } from './native-followup-reset-source.mjs';
/** Keep the real native recorder alive across an official physical session reset. */
export async function resetProof(f, mapping) {
  const child = spawn(
    'docker',
    [
      'exec',
      '--user',
      '1000:1000',
      '-i',
      f.name(),
      'node',
      '--input-type=module',
      '-e',
      frameSource(resetSource),
      JSON.stringify(mapping),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let errors = '';
  child.stderr.on('data', (data) => {
    errors = (errors + data).slice(-4000);
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const completed = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      const safe = errors
        .replace(/https?:\/\/[^\s"']+/gu, '[private-url]')
        .replace(
          /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/giu,
          '[native-id]',
        );
      if (code === 0) accept();
      else
        reject(new Error(`Physical generation probe exited ${code}: ${safe}`));
    });
  });
  completed.catch(() => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try {
    const ready = await nextResult(lines);
    assert.equal(ready.phase, 'ready');
    const acknowledgement = await f.gateway.request('sessions.reset', {
      key: mapping.sessionKey,
      agentId: mapping.agentId,
      reason: 'reset',
      expectedSessionId: ready.scope,
    });
    const fresh = await f.node(
      `
import {readFile} from 'node:fs/promises';
import {loadGatewaySessionEntryReadOnly} from '/app/dist/session-utils-store-DT1w1HJu.mjs';
const [mapping,previous]=JSON.parse(process.argv[1]);
const cfg=JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
const selected=loadGatewaySessionEntryReadOnly(mapping.sessionKey,{agentId:mapping.agentId},cfg);
emit({entryPresent:Boolean(selected.entry),lifecycleRevisionChanged:typeof selected.entry?.lifecycleRevision==='string'&&selected.entry.lifecycleRevision!==previous,uid:process.getuid()});
`,
      [JSON.stringify([mapping, ready.revision])],
    );
    assert.equal(acknowledgement?.ok, true);
    assert.equal(typeof acknowledgement?.entry?.lifecycleRevision, 'string');
    assert.notEqual(acknowledgement.entry.lifecycleRevision, ready.revision);
    assert.equal(fresh.uid, 1000);
    assert.equal(fresh.entryPresent, true);
    assert.equal(fresh.lifecycleRevisionChanged, true);
    child.stdin.end('reset-complete\n');
    const result = await nextResult(lines);
    assert.equal(result.uid, 1000);
    assert.equal(result.phase, 'done');
    await completed;
    return result;
  } catch (error) {
    // EOF can precede process exit: preserve the native failure instead of masking it.
    if (child.stdout.readableEnded) await completed;
    throw error;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGKILL');
    await retainOutput(errors);
  }
}
