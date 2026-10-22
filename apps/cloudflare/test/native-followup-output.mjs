import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const prefix = 'MESSENGER_NATIVE_RESULT:';
const log = resolve(
  import.meta.dirname,
  '../../../.context/native-followup-native-output.log',
);
export const frameSource = (source) =>
  `const emit=value=>process.stdout.write(${JSON.stringify(prefix)}+JSON.stringify(value)+'\\n');\n${source}`;
export async function retainOutput(output) {
  await appendFile(log, output + '\n', { mode: 0o600 });
}
function decode(line) {
  assert.ok(
    Buffer.byteLength(line) <= 1_048_576,
    'Diagnostic frame is bounded',
  );
  const value = JSON.parse(line.slice(prefix.length));
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    'Diagnostic frame must be an object',
  );
  return value;
}
export async function parseResult(output) {
  await retainOutput(output);
  const frames = output.split('\n').filter((line) => line.startsWith(prefix));
  assert.equal(
    frames.length,
    1,
    'Require exactly one explicit native diagnostic result',
  );
  return decode(frames[0]);
}
export async function nextResult(lines) {
  let bytes = 0;
  for (;;) {
    const next = await lines.next();
    assert.equal(
      next.done,
      false,
      'Native diagnostic ended before its explicit result',
    );
    bytes += Buffer.byteLength(next.value);
    assert.ok(bytes <= 1_048_576, 'Unframed diagnostic output is bounded');
    await retainOutput(next.value);
    if (next.value.startsWith(prefix)) return decode(next.value);
  }
}
