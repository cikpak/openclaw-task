# Implementation acceptance

## Cloudflare implementation — 2026-10-22

The current architecture is being delivered in five phases. Phases1–4 have
recorded checks; Phase 5 integration and publication are being finalized. The
[current release record](release-verification.md) owns present pass/fail/deployment
status. Replacement OpenAI credentials passed private model-list validation;
bounded direct paid inference also passed. The public real-provider application
cycle remains pending. See [current architecture](architecture.md) and [operations](operations.md).

The records below are **historical evidence for the earlier topology**. Their
commands, unresolved publication status and deployment details do not describe
the current Cloudflare runtime. Preserve failed attempts and later qualifications.

The binding approved specification is the local-only `docs/plans/approved-openclaw-messenger.md`; it is not included in Git. The original local attachment is `.context/attachments/EmTrws/plan.md`. Repository readers can use [architecture.md](architecture.md) for the tracked architecture.

## Latest recorded verification 2026-10-13

The verified application/test revision is `1af649b2d890d122bb09e1ee8b5c865d3cedc0f3`
(tree `699bb232ed4c3dc3184ee13707f17710c72743b3`). Subsequent documentation-only
updates do not constitute a new application test run or new GitHub CI evidence.

- Local types, lint, formatting, tests and build passed: 225 backend, 230 frontend
  and 57 deployment/bootstrap tests, totaling 512 passed; six platform-inapplicable
  backend tests skipped on macOS. Existing build warnings remain.
- Fresh real-Gateway acceptance passed Gateway/media contracts, 30 desktop/mobile
  browser journeys, backend/Gateway restart recovery and ten-agent capacity. Two
  mobile duplicates of desktop-only fault cases intentionally skipped. Ten local
  provider requests overlapped; four excess reservations were rejected; the maximum
  observed snapshot was 1,270 bytes. No paid provider was used.
- The first local acceptance invocation failed a steering/Stop fixture race; an
  unchanged replay passed. The repaired fixture then passed full acceptance by
  testing abort against an explicitly active delayed turn after steering delivery.
  Earlier failures remain historical, not erased by the final pass.
- A separate fresh startup with the normal production backend and local provider
  reached running services and frontend assets/login/health/ready HTTP 200 in about
  33 seconds, with build cache. Gateway/media smoke and one complete desktop journey
  then passed. This was not the full browser suite or an uncached build benchmark.

PR1 in `cikpak/oc-test-task` merged on 2026-10-13 as `b9b3018`. Its latest PR checks
and acceptance passed, but a separate push acceptance run failed Gateway restart
readiness; the user approved merging that disclosed risk. The intermittent cause
is not claimed fixed. The latest local test fix `1af649b` has not been pushed to
either repository and has no newly observed CI result. The user-requested private
`cikpak/oc-test` export contains the clean-history snapshot `2899982`, not this fix.

All owned synthetic test projects and their disposable volumes were removed;
the live app and private provider environment were untouched. Paid-provider
execution, Droplet/public-IP deployment and physical/non-Chromium browser checks
remain unverified. The [assessment matrix](acceptance.md) maps the supplied task
to implementation and explicitly records the partial Config Generator bonus.

## Historical verification 2026-10-12

| Phase                                  | Status                          | Acceptance evidence                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: workspace, auth, pairing, real chat | Implemented and source reviewed | Fresh automatic exact-device pairing, readiness, pinned real model/session creation, streaming and logout smoke; ten parallel native creations without serializing sends                                                                                                     |
| 2: lifecycle, durable queues, settings | Implemented and source reviewed | Recorded 2026-10-12 backend gate: 117 tests across 10 files; SQLite race/recovery, queue position, settings, bounded projections and exact terminal/history fencing covered                                                                                                  |
| 3: responsive messenger and drafts     | Implemented                     | Recorded 2026-10-12 frontend gate: 61 tests across 9 files; preference-response ETag regressions, paired settings/name/ETag hydration, explicit conflict refresh/resave, reader-preserving streaming including equal-length replacements, and 16px recovery guidance covered |
| 4: tools, uploads, artifacts           | Implemented and source reviewed | Real Gateway consumed TXT/Markdown/text PDF/PNG, emitted write/read tools, retained reconnect snapshots and transferred native PNG bytes with cross-chat denial. Strict media response and capability-cache boundaries have backend regressions                              |
| 5: faults, resources, documentation    | Implemented                     | Fresh consolidated local acceptance passed Gateway/media, fourteen browser journeys and native ten-run capacity with four concurrent excess-creation rejections; two duplicate mobile fault cases intentionally skipped; container resource samples recorded                 |

On 2026-10-12, before this documentation pass, the frozen reviewed source passed the whole local quality gate: frozen-lockfile install, strict types, lint, formatting, 194 tests (117 backend, 61 frontend and 16 deployment/import-boundary), and build. That captured command completed at 15:00 UTC. The fresh `ACCEPTANCE_PORT=18084 pnpm test:acceptance` then exited successfully at 15:09 UTC after about nine minutes, using project `messenger-acceptance-cbfa8f89`, the actual pinned OpenClaw `2026.10.1`, and a local deterministic provider. Gateway/media contracts and fourteen browser journeys passed; two shared mobile fault duplicates skipped before login. Capacity observed ten overlapping provider calls, ten independent canonical completions, four excess-create `409` rejections, and a maximum snapshot of 1,109 bytes. The runner cleaned only its owned disposable project and volumes.

Earlier results remain historical: the 111-backend/49-frontend/16-deployment quality pass, the later 51-test frontend focused gate, the consolidated acceptance that failed with a real login `429` before its second mobile body-level skip and never reached capacity, and the native capacity invocation that failed its 120-second completion gate. The restarted targeted capacity attempt that stopped at setup HTTP `502` also remains failed. Focused passes and failed invocations are not consolidated success. At that 2026-10-12 documentation audit, final verification after documentation and the final commit was pending, branch GitHub CI had not run, and publication was stopped. The dated 2026-10-13 record above supersedes that publication/verification status without changing these historical results.

Both responsive layouts have verified canonical initial/follow-up pairs and saved authenticated screenshots. Mobile controls were measured against 44px targets and form fields against 16px text. The mobile backend/Gateway-restart and expiry duplicates now skip before login/cleanup because desktop exercises their shared lifecycle boundaries. A blocked-origin red/green probe observed two setup failures before the repair and two skips without login afterward; this is eligibility proof, not full acceptance. Production login throttling remains five attempts per minute. Authenticated visual evidence comes from Playwright; manual gstack evidence covers public login only, not an authenticated session or a physical mobile device.

Deletion waits for a fresh local settings/version read, independently of remote model availability. A later background settings application can still advance the version; the browser journey checks the safe conflict, explicitly refreshes and reviews saved values, then confirms deletion again. Neither the application nor the test silently bypasses the version guard or treats the first rejected request as accepted.

During the pinned Gateway's active-run restart, canonical recovery can complete without an original pending-input receipt. The verified browser journey checks the original canonical input once, visible unconfirmed delivery, retained draft/next queue, and no automatic replay; only then it explicitly discards the unresolved local delivery record and verifies the next queued item and a subsequent turn complete once. This is not a promise of unconditional idle or a normal pre-restart reply after killing execution.

Tests against a fake Gateway prove application behavior only. Real Gateway and
provider checks are recorded separately; passing mocks never imply real integration.

The consolidated fresh-stack command is `pnpm test:acceptance`. It uses a local deterministic provider behind the actual pinned OpenClaw Gateway and removes only its disposable project volumes. The opt-in `pnpm test:live-provider` is implemented but has not been executed; no paid-provider check is claimed. See [testing.md](testing.md) for reproduction and [acceptance.md](acceptance.md) for coverage and limitations.
