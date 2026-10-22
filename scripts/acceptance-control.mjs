import assert from 'node:assert/strict';
import { until } from './acceptance/client.mjs';
const action = process.argv[2];
assert.ok(
  [
    'status',
    'alarm',
    'restart-manager',
    'restart-gateway',
    'expire-sessions',
  ].includes(action),
  'Explicit test control action required',
);
assert.match(
  process.env.ACCEPTANCE_PROJECT ?? '',
  /^messenger-acceptance-[a-z0-9-]+$/u,
  'Only the isolated acceptance runner enables controls',
);
const origin =
  process.env.ACCEPTANCE_HARNESS_ORIGIN ?? process.env.ACCEPTANCE_ORIGIN;
const before = await (await fetch(`${origin}/__acceptance/status`)).json();
assert.equal(
  typeof before.construction,
  'number',
  'Acceptance-only harness is required',
);
const response = await fetch(`${origin}/__acceptance/${action}`, {
  method: action === 'status' ? 'GET' : 'POST',
});
assert.equal(response.status, 200);
const body = await response.json();
if (action !== 'status') assert.equal(body.ok, true);
if (action === 'restart-manager')
  await until(
    async () =>
      (await (await fetch(`${origin}/__acceptance/status`)).json())
        .construction > before.construction,
    'Manager must actually reconstruct',
    10_000,
  );
