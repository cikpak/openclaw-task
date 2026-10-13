# Testing the messenger

Use Node.js 24, pnpm 10.29.3, Docker Engine/Desktop with Compose 2.24.4 or newer, and Chromium installed by Playwright. The production OpenClaw image and protocol packages are pinned together at `2026.10.1`.

## Fast checks

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

`pnpm test` runs backend Vitest tests with real SQLite, frontend component/store tests, bootstrap policy checks, and import-boundary regressions. These exercise malformed Gateway responses and transport interruptions without needing model credentials.

If competing Docker workloads cause test-runner timeouts, run the same suites with lower concurrency; assertions and timeouts remain unchanged:

```sh
pnpm --workspace-concurrency=1 -r test --maxWorkers=1
pnpm test:bootstrap
```

## Fresh real-Gateway acceptance

```sh
pnpm exec playwright install chromium
pnpm test:acceptance
```

On Linux CI, install Chromium system dependencies with `pnpm exec playwright install --with-deps chromium` instead. Docker must be running. The acceptance command generates private synthetic credentials under `.context/` if they are absent, starts a new random `messenger-acceptance-*` Compose project, and waits for automatic exact-device pairing and `/ready` without manual Gateway configuration. It verifies the resolved three-service network topology, persistent volume mounts, health checks, and rejection of an empty Gateway token.

This readiness polling is stricter than ordinary
`docker compose up --build -d --wait --wait-timeout 300`: the backend container
healthcheck checks `/health` liveness, and the frontend has no healthcheck.
For an application stack, verify `/ready` separately before testing chat. The
recorded cold-start smoke used the normal production backend entrypoint with a
local provider and verified frontend assets, readiness and functional requests.

The command executes the pinned real OpenClaw Gateway against an HTTP model provider running inside the OpenClaw container. The provider supplies deterministic text, delayed responses, and real allowed workspace tool calls. Backend/Gateway traffic still uses TLS, certificate pinning, device authentication, canonical sessions, and the actual Gateway protocol. No external provider key or paid model invocation is needed. The test override is used only with `compose.test.yaml`; normal `compose.yaml` uses the configured provider.

Gateway contract smoke verifies model projection, real agent/session creation, session settings read-back, streaming, canonical history, and cookie revocation. Media acceptance verifies actual TXT, Markdown, text PDF and PNG consumption, allowed workspace write/read tools, tool state across browser reconnect, and native image-artifact bytes with cross-chat denial. Fixture images are seeded only in a validated, newly owned chat workspace in the local deterministic project.

Playwright runs one worker with desktop Chrome and a Pixel 7 viewport. Both layouts exercise creation, messages, rename/deletion, independent drafts, browser offline/reconnect, stable-position queue edits and cancellation, deferred/cancel-work settings, steering, abort, preferences, upload rejection, real tool display, native artifact downloads, entire browser-context closure, and cross-tab logout. The closure journey waits for accepted work to finish with no browser WebSocket connected before opening a fresh browser context. A desktop fault test restarts the isolated backend with accepted active/queued input, then restarts the Gateway during a separately delayed active run with queued work. The pinned Gateway may finish a recovery continuation without an original pending-input receipt; the test requires explicit unconfirmed delivery, retained queue/draft, and no automatic replay, checks canonical history, then chooses Discard before verifying the next queued item completes once. Another desktop test expires the synthetic durable session while its socket is open and confirms further input is rejected. Responsive rendering has the same backend lifecycle, so these expensive fault boundaries run once.

The final capacity stage creates ten real agents concurrently, rejects four concurrent attempts to create an eleventh, and submits ten unique inputs. The private test provider records actual overlapping model requests, requiring a peak of ten before completion. Each transcript must contain only its own input/response marker. Recent snapshot sizes and history/tool windows are checked, and baseline/concurrent/completed Docker CPU and memory samples are recorded in `.context/resource-evidence.json`. This is a bounded deterministic runtime workload, not an external-model quality or latency benchmark. The isolated Gateway restarts before this stage to release workers retained by preceding test chats.

The steering/abort journey requires submitted or canonical steering delivery
before settling that turn. Delivery proof does not imply a run remains active:
a short reply can already be complete. The journey therefore starts an explicit
`LONG_RESPONSE_FIXTURE` turn and requires Stop to be visible before aborting it,
retaining the original delivery, queue, settings and other-chat isolation checks.

Each test clears only chats in the synthetic test account using authenticated, versioned deletion, waiting for confirmation before consuming capacity again. The random Compose project is torn down with its own disposable volumes in `finally`. Application projects and production volumes are never reused. Set `ACCEPTANCE_PORT` to an unused loopback port if 18080 is occupied.

For debugging, `ACCEPTANCE_KEEP=1 pnpm test:acceptance` retains its generated synthetic project and prints its exact name. After inspection, remove only that project with `docker compose --env-file .context/test.env -p <printed-project> -f compose.yaml -f compose.test.yaml down --volumes --remove-orphans`, using the same `ACCEPTANCE_PORT`. Normal runs and CI always clean up automatically.

For an existing **synthetic deterministic** acceptance stack, run:

```sh
ACCEPTANCE_PORT=18080 ACCEPTANCE_PROJECT=messenger-acceptance-example pnpm test:e2e
```

Do not point this command at a real user's data: its per-test cleanup deletes the synthetic account's conversations. The fixture helper rejects a Gateway configuration without the local deterministic provider. The restart test additionally requires a `messenger-acceptance-*` project name.

## Evidence and failures

The focused `e2e/chat-polish.spec.ts` journeys verify stable async-button and composer geometry, 16px outline icons with a 24-unit viewBox, dialog-contained select positioning and keyboard focus, animated/reduced-motion modal behavior, route titles/favicon, and transport-aware connection colors. Streaming checks match cumulative received text frames to actual foreground DOM paints, require multiple partial responses before completion, measure the first frame-to-paint delay against 150ms, and verify chronology, 85% bubble widths, wrapping, and reader-controlled scrolling. These run only against a validated synthetic acceptance project and do not claim external-provider latency or streaming behavior.

These journeys save desktop/mobile renders to `.context/screenshots/chat-polish-{desktop,mobile}.png` and content-free geometry/timing evidence to `.context/chat-polish-{controls,stream}-{desktop,mobile}.json`.

The successful first journey saves authenticated desktop/mobile renders under `.context/screenshots/messenger-desktop.png` and `.context/screenshots/messenger-mobile.png`, after canonical user/assistant pairs are verified. Mobile journeys also measure relevant controls against 44px target dimensions and form fields against 16px text. Manual gstack browsing covers the public login screen only; authenticated visual evidence comes from these repository browser tests, not a claimed manual authenticated session.

Failure screenshots and traces are saved under `.context/playwright-results/`; the HTML report is `.context/playwright-report/index.html`. They may contain synthetic credentials and message content, so `.context/` is ignored. CI uploads these synthetic browser artifacts and any resource evidence on failure, with seven-day retention. CI has separate fast-check and Compose/Gateway/browser jobs; successful local runs do not imply a GitHub CI run has passed.

The acceptance matrix in [acceptance.md](acceptance.md) maps requirements to their evidence. Live-provider behavior is distinct from the deterministic-provider proof; it requires deliberately supplied credentials, a separately configured stack, and an explicitly enabled smoke command. Do not describe a local deterministic run as a live-provider check.

For a deliberately authorized live-provider check, put the application password in a private file and choose an available external model explicitly:

```sh
LIVE_PROVIDER_SMOKE=1 LIVE_PROVIDER_ORIGIN=http://localhost:8080 \
  LIVE_PROVIDER_MODEL=anthropic/claude-sonnet-4-5 \
  LIVE_PROVIDER_PASSWORD_FILE=/absolute/path/to/private-password.txt \
  pnpm test:live-provider
```

The opt-in smoke creates and deletes one disposable conversation, asks for a short response without tools, and verifies accepted input plus a nonempty completed canonical reply. It does not assert exact model wording or log credentials/content. It can incur model charges and is not run automatically.
