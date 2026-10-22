import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export async function ownedContainer() {
  const id = process.env.ACCEPTANCE_PROJECT?.replace(
    /^messenger-acceptance-/u,
    '',
  );
  assert.match(
    id ?? '',
    /^[a-f0-9]{12}$/u,
    'An exact isolated acceptance namespace is required',
  );
  const prefix = `workerd-openclaw-local-${id}-manager-ConversationManager-`;
  const { stdout } = await execute(
    'docker',
    ['ps', '--format', '{{.Names}}', '--filter', `name=${prefix}`],
    { timeout: 15000, killSignal: 'SIGKILL' },
  );
  const names = stdout
    .trim()
    .split('\n')
    .filter((name) => name.startsWith(prefix) && !name.endsWith('-proxy'));
  assert.equal(
    names.length,
    1,
    'One owned native engine container is required',
  );
  return names[0];
}
export async function providerStats() {
  const container = await ownedContainer();
  const { stdout } = await execute(
    'docker',
    [
      'exec',
      container,
      'node',
      '-e',
      "fetch('http://127.0.0.1:18889/acceptance/stats').then(r=>r.json()).then(s=>console.log(JSON.stringify(s)))",
    ],
    { timeout: 15_000 },
  );
  return JSON.parse(stdout);
}
export async function sampleResources() {
  const container = await ownedContainer();
  const { stdout } = await execute(
    'docker',
    ['stats', '--no-stream', '--format', '{{json .}}', container],
    { timeout: 15_000 },
  );
  return { sampledAt: Date.now(), engine: JSON.parse(stdout) };
}
