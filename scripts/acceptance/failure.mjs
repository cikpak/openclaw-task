import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { providerStats } from './docker.mjs';
const namespace = process.env.CLOUDFLARE_WORKSPACE_ID;
assert.match(namespace ?? '', /^[a-f0-9]{12}$/u);
assert.equal(
  process.env.ACCEPTANCE_PROJECT,
  `messenger-acceptance-${namespace}`,
);
const origin = process.env.ACCEPTANCE_HARNESS_ORIGIN;
async function read(path) {
  try {
    const response = await fetch(`${origin}/__acceptance/${path}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { unavailable: true, httpStatus: response.status };
    const value = await response.json();
    return JSON.stringify(value).length <= 65536
      ? value
      : { evidenceTruncated: true };
  } catch {
    return { unavailable: true };
  }
}
// Failure-only reads: success-path execution and browser timing are unchanged.
const [status, receiptProof, provider] = await Promise.all([
  read('status'),
  read('receipt-proof'),
  providerStats()
    .then((stats) => ({
      calls: stats.diagnostics.length,
      completed: stats.diagnostics.filter((item) => item.completed).length,
      active: stats.diagnostics.filter((item) => !item.closed).length,
      capacity: stats.capacity,
    }))
    .catch(() => ({ unavailable: true })),
]);
await writeFile(
  '.context/acceptance-failure-structure.json',
  JSON.stringify(
    {
      namespace,
      stage: process.env.ACCEPTANCE_FAILED_STAGE,
      status: {
        unavailable: status.unavailable ?? false,
        phase: status.phase ?? null,
        helperReady: status.helperReady ?? false,
        sdkReady: status.sdkReady ?? false,
        gatewayProcess: status.gatewayProcess ?? null,
        running: status.running ?? false,
        pending: status.pending ?? null,
        hasLifecycleFailure: Boolean(status.failure),
        timings: status.timings ?? [],
      },
      receiptProof,
      provider,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.info('Saved bounded structural failure evidence before exact cleanup.');
