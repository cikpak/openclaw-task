# Testing the messenger

Use Node.js 24, pnpm 10.29.3, running Docker Engine/Desktop and Playwright Chromium.
Worker tooling is pinned: cf 1.0.0-beta.19, Vite 8.3.4 and Cloudflare plugin
2.0.0-beta.v.3. Wrangler 4.136.0 is for Pages commands only. OpenClaw/SDK 2026.10.1
and the immutable image digest must move together after compatibility verification.

## Repository gates

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

Workspace package tests run serially to avoid CPU-contention timing failures on
the development Mac; this does not remove assertions or extend deadlines.
Backend tests exercise portable domain/SQL behavior and the retained Node
compatibility adapter. Production routing/auth lives in Cloudflare, not that
adapter. Frontend tests exercise stores, transport, components and recovery.
Bootstrap/import checks enforce policy and bundle boundaries.

## Actual Workers and native engine checks

`pnpm --filter @messenger/cloudflare test` runs Cloudflare Vitest plus Node-driven
actual workerd/Miniflare checks. These cover D1/DO persistence, admission/ownership,
file staging, publication, streaming downloads, readers, cleanup and lifecycle
failure races rather than assuming mocks establish Worker compatibility.

```sh
pnpm --filter @messenger/cloudflare test:engine
```

The unified runner builds the current production helper context, pins its immutable
image ID and runs isolated Docker/native fixtures without a paid provider: exact
device approval/token reuse, complete long-message retrieval, writer drain,
state/file/ownership restore, native pagination, handoff, PDF extraction and safe
first-use directory creation. Direct recovery readback verifies all objects,
including reused objects, corruption/missing/size failures and cancellation, while
manager tests prohibit recovery-body reads. It
cannot silently rely on an old phase-specific image tag. Standalone helper scripts
require explicit `OPENCLAW_TEST_IMAGE`; prefer the unified runner. Production image
build context excludes test fixtures and synthetic providers. Test-only native
injection in verification scripts is not a production route.

Fresh Cloudflare local harness and browser acceptance commands are documented in
[operations](operations.md). Use only isolated test state: destructive acceptance
cleanup must never target production or a real user's data. Failure screenshots,
traces, generated private test credentials and raw fixtures belong in ignored
`.context/`, not public CI logs or commits. Current CI runs checks, not deployment.

## Isolated local Cloudflare acceptance

```sh
pnpm exec playwright install chromium
pnpm test:acceptance
```

This command creates fresh random workspace-local test state and credentials,
starts the actual Cloudflare harness and pinned native container, and runs Gateway,
media, lifecycle, desktop/mobile Playwright and capacity checks. A deterministic
provider adapter is installed only by the local acceptance/test environment; it is
absent from production image configuration and release artifacts. No external
provider credential is required. Passing this fixture is not real-provider proof.
Separate local Gateway/media/lifecycle, browser and capacity passes are recorded
as separate invocations; they never imply a fresh single aggregate pass. Run one
complete current-source local aggregate and observe the final-commit GitHub CI
`pnpm test:acceptance` result before claiming release acceptance passed.

The normal runner opts into a read-only success-only after-case oracle for the
unchanged desktop/mobile steering journey. It records exact scoped native owner
and causal-result evidence after all original assertions, without changing sends
or timing. Valid true-Steer/direct-start outcomes are marked UNSUITABLE for
late-fallback coverage, never relabeled or made a random CI failure. Both layouts
must produce valid records; generated-owner coverage is reported separately. The
strict image integration independently forces and verifies a generated owner.
`pnpm test:acceptance-unit` checks these artifacts, private readonly bindings and
bounded exact-owned cleanup, and is included by `pnpm test`/CI.
The runner cleans only its owned disposable containers; ignored local reports and
private fixtures remain available for diagnosis. Confirm actual command outcomes
in the release record rather than inferring success from this documented flow.

## Evidence interpretation

Read [release verification](release-verification.md) for actual phase totals and
known failures. Unit passes, actual Worker-runtime passes, native provider-free
checks, browser cached access, public deployment and real-provider execution are
separate claims. Historical Compose commands/results are preserved under
[history](history/pre-cloudflare-testing.md) and are not current instructions.

The full release check needs a valid private provider credential and selected
available model. Never substitute a synthetic production provider or treat
`chat.inject` as a model turn. With credentials, verify accepted input and a real
completed reply, then automatic idle preservation/stop, asleep download without
wake, restored identity/settings/files and continuation in the same conversation.
Record helper start, restore, Gateway start, SDK authentication and dispatch times
separately. No startup SLA follows from an isolated experiment.

## Logging verification

Admission tickets occur in WS queries and download paths. Verify successful,
rejected and replayed sentinel admissions against sanitized route-only logs and
configured sinks. Invocation URL logs/traces are disabled. Do not retain raw
Pages tail envelopes: they expose full URL/headers and are not a redaction test.
Never record cookies, authorization, provider/R2/helper/Gateway secrets or native
frames. Inspect frontend artifacts for server-secret values without printing them.
