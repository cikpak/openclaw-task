import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fallbackContext } from './fallback-context.mjs';
export function validateFallbackRecords(records, namespace) {
  assert.match(namespace, /^[a-f0-9]{12}$/u);
  assert.equal(
    records.length,
    2,
    'Both responsive after-case records required',
  );
  for (const project of ['desktop', 'mobile']) {
    const matches = records.filter((record) => record?.project === project);
    assert.equal(
      matches.length,
      1,
      'Exactly one record per responsive project required',
    );
    const record = matches[0];
    assert.equal(record.namespace, namespace, 'No stale namespace evidence');
    for (const field of [
      'accepted',
      'queryScoped',
      'pendingCleared',
      'nativeInactive',
      'causalSuccessfulFinal',
    ])
      assert.equal(
        record[field],
        true,
        'Valid scoped completed outcome required',
      );
    assert.ok(
      ['verified-original', 'not-retained-after-settlement'].includes(
        record.scopeStatus,
      ),
    );
    assert.ok(
      Number.isSafeInteger(record.canonicalInputCount) &&
        record.canonicalInputCount >= 0,
    );
    assert.ok(
      Number.isSafeInteger(record.processingSequenceCount) &&
        record.processingSequenceCount >= 0,
    );
    assert.ok(['generated-owner', 'UNSUITABLE'].includes(record.kind));
    if (record.kind === 'generated-owner') {
      assert.equal(record.association, 'generated-owner');
      assert.ok(record.processingSequenceCount > 0);
    } else {
      assert.ok(
        ['explicit-original-owner', 'confirmed-steer', 'direct-input'].includes(
          record.association,
        ),
      );
      if (record.association === 'explicit-original-owner')
        assert.ok(record.processingSequenceCount > 0);
      else {
        assert.equal(record.processingSequenceCount, 0);
        assert.equal(record.canonicalInputCount, 1);
      }
    }
  }
  const generatedSamples = records.filter(
    (record) => record.kind === 'generated-owner',
  ).length;
  return {
    validLayouts: 2,
    generatedSamples,
    generatedCoverage: generatedSamples ? 'observed' : 'UNSUITABLE/uncovered',
    forcedGeneratedImageGateRequired: true,
  };
}
export async function verifyFallbackCoverage(env = process.env) {
  const context = fallbackContext(env);
  const records = await Promise.all(
    ['desktop', 'mobile'].map(async (project) =>
      JSON.parse(
        await readFile(join(context.directory, `${project}.json`), 'utf8'),
      ),
    ),
  );
  const result = validateFallbackRecords(records, context.namespace);
  console.info(`UI generated-owner coverage: ${JSON.stringify(result)}`);
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await verifyFallbackCoverage();
