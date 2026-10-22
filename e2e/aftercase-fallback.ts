import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestInfo } from '@playwright/test';
import { classifyFallbackProof } from '../scripts/acceptance/fallback-proof.mjs';
import { fallbackContext } from '../scripts/acceptance/fallback-context.mjs';
import { aftercaseBinding } from './aftercase-binding.js';

/** Success-only after-case evidence. No sends, engine wake, or transport observation. */
export async function recordUiFallback(testInfo: TestInfo) {
  try {
    if (!['desktop', 'mobile'].includes(testInfo.project.name))
      throw new Error();
    const context = fallbackContext(process.env);
    const namespace: unknown = context.namespace;
    if (typeof namespace !== 'string') throw new Error();
    const input = await aftercaseBinding(context.stateDir, namespace);
    const response = await fetch(
      `${context.harnessOrigin}/__acceptance/outcome-proof`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(40_000),
      },
    );
    if (!response.ok) throw new Error();
    const summary = classifyFallbackProof((await response.json()) as unknown);
    const record = {
      namespace,
      project: testInfo.project.name,
      ...summary,
    };
    const content = JSON.stringify(record, null, 2);
    await mkdir(context.directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(context.directory, `${testInfo.project.name}.json`),
      content,
      { mode: 0o600, flag: 'wx' },
    );
    await testInfo.attach('Native processing association proof', {
      body: Buffer.from(content),
      contentType: 'application/json',
    });
  } catch {
    // Never include private child output, accepted identities, native text, or response bodies.
    throw new Error(
      'The post-case native processing proof could not be validated.',
    );
  }
}
