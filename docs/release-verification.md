# Release verification

## Current repaired deployment — 2026-10-22

The manual immutable production revision
`a65dc7f125827904d442620fcb9cde01e13ce56a` is live at
<https://openclaw-messenger.pages.dev>. Manager version
`3ec9963d-c483-4dfc-824b-6a1b411b685b`, Backend version
`27147bd3-f71b-422e-acf4-942ab469646b` and Pages deployment `1dd1bd21`
were deployed locally, with container rollout `none`. CI performs checks only.
Public HTML, JavaScript and CSS hashes match the immutable artifact. The release
image's RootFS and configuration match the physically tested helper image; seven
native transformations and both companion hashes were independently verified.

Actual public GPT-5 verification passed:

- Forty-seven authentication/routing checks, including exact-session admission,
  replay/origin protections, expiry and logout.
- A real native write created and published a forty-one-byte document. The durable
  send ACK took 78 ms and its canonical reply completed in 34,464 ms after a live
  model listing had already started the engine.
- Automatic preservation produced a private R2 archive/manifest. External
  Cloudflare instance reads confirmed zero active engine instances. The original
  file downloaded with its exact SHA-256 without waking the engine; single use,
  exact-session binding and expiry after sixty-two seconds were verified.
- A later send in the same conversation ACKed in 97 ms and completed in 188,019 ms,
  including cold restoration and provider execution. Original memory, effective
  settings and file bytes survived. A private audit of only this owned agent's
  saved native transcript correlates the actual post-acceptance read call and
  successful output, with zero subsequent write/edit calls.
- The engine automatically preserved and stopped again after that continuation;
  independent Cloudflare reads again confirmed zero active instances.

These are observations, not a startup SLA. Public phase timings include network,
restoration, native authentication and provider execution. A separate local
provider-free lifecycle fixture measured helper startup 1,042 ms, restore 35,042
ms, Gateway process startup 66 ms, SDK authentication 34,766 ms and dispatch 1,169
ms; these values do not substitute for public production timing.

The a65 revision passed types, lint, formatting, build and 1,081 local core tests
with six existing platform skips. Exact-head Linux CI passed the complete fresh
native image suite: files, directories, handoff, PDF, readback, preservation,
native SDK, owner patch, followup and tool-policy recovery. The original local
aggregate and both a65 CI aggregates passed all application stages: thirty
Chromium desktop/mobile cases, two existing duplicate mobile skips, genuine
private generated-owner coverage in both layouts, recovery and ten-agent capacity
with four concurrent excess-create rejections. **Their aggregate exits remain
failed at test-container teardown.** Local final inspection nevertheless proved
owned absence, both closed ports and all four unrelated containers preserved.

The test-only cleanup repair retains exact-name inspection before every removal,
allows only classified Docker removal-in-progress/not-found responses to settle
within a finite deadline, and requires final absence, closed ports and preserved
baselines. Unknown failures and timeouts remain failures. Seventy-three focused
acceptance-unit tests passed, including six new settling/classifier cases. CI now
retains finite cleanup diagnostics; the discarded original Docker error text
cannot establish the exact historical cause. Final branch-head CI is tracked on
[PR 1](https://github.com/cikpak/openclaw-task/pull/1). Later cleanup-script and
documentation commits do not alter the deployed application or helper bytes.

The subsequent `87c2ccf` Linux checks passed 1,092 core tests and the complete
native suite. Its push acceptance passed every stage including cleanup. The PR
acceptance passed all product stages but retained only known Docker
removal-in-progress at the thirty-second deadline; the successful run settled near
29.5 seconds. The test-only window now permits sixty seconds for those known
responses, with a 30.25-second success regression and persistent-at-sixty failure
regression. All seventy-four focused acceptance-unit tests pass; command timeouts,
unknown failures and final absence/port/baseline proofs remain unchanged.

At `0301cbe`, both source/native jobs passed (1,093 core tests and all ten
native checks), and the push aggregate passed all thirty application journeys,
two existing skips, lifecycle, capacity and strict sixty-second cleanup. The PR
cleanup also passed, but its mobile notification-target assertion compared 44px
with 43.99999237060547px. It stopped at twenty-four passed cases, one existing skip
and six not run; capacity was not reached. The saved trace confirms 44px minimum
CSS, so this is a test-coordinate precision failure rather than changed layout.

A test-only 0.0001 CSSpx allowance now covers that noise while retaining visibility,
non-null geometry and the 44px target requirement. Six actual Chromium static-page
regressions passed independently in both layouts: near-44px noise passes and
43.99px/43px width and height still fail. Types, scoped lint and formatting passed.
The full browser inventory is now thirty application journeys plus these six
precision regressions, with the same two existing skips. Production application,
helper, dependency and deployment files remain identical to the deployed artifact.

## Historical phase and deployment evidence

Earlier failed attempts and phase results below remain historical; their pending
statements describe those checkpoints rather than the repaired public cycle.

Implementation phases 1–4 are committed and independently reviewed. At the Phase 4
handoff, local typecheck, lint, formatting, build, whitespace and LOC audits passed.
The recorded suite total is **722 passed, six existing skips**: backend 253,
Cloudflare 117 Vitest plus 41 Node/workerd, frontend 254 and bootstrap 57.
These are recorded phase results, not a claim that the final release commit or its
GitHub CI has passed. Phase 5 validation/publication/deployment results must be
appended with the exact release revision and observed outcome.

| Boundary                       | Observed evidence                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual Workers runtime         | D1 sessions/tickets, SQL queue/receipt persistence across process restart, ownership/replay checks, bounded 5 MiB upload restart, exact-session download admission, logout-completing streams, reader/restore pins and uncertain cleanup |
| Pinned SDK / Docker            | Exact expected identity pairing, wrong identity rejection, persisted device-token authentication with invalid shared token, reconnect and native history pagination after append                                                         |
| Complete native replies        | Exact 2,530,000-character reply retained beyond 500,000-character history and 2,000,000-character message display caps                                                                                                                   |
| Helper preservation            | 65 documents, 129 MiB unknown private file, foreign ownership/modes, safe/escaping symlink rules and nonstandard SQLite databases/sidecars                                                                                               |
| Real R2 / fresh helper         | Original native session, settings, full history and files restored; isolated native test-only continuation; owned objects independently hash-read before dedicated verification-bucket cleanup                                           |
| Actual Chromium cached access  | Production frontend plus actual Workers/D1/DO without a container binding; login/socket/history/unread worked; desktop cache 80→13 whole messages, mobile 13→2                                                                           |
| Credential/publication privacy | Known-secret scans, current-input denial, opaque publication, private fallback denial and helper request-body credential-role regressions                                                                                                |

The cached-access proof is not an execution test. Isolated native `chat.inject`
verification is not model-provider execution and is never an application/helper
seed endpoint. Earlier experiments establish feasibility, not deployed startup SLA.

## Earlier provider gate — superseded by the repaired deployment

The original supplied OpenAI key returned HTTP 401 `invalid_api_key` and remains
excluded. On 2026-10-22, a replacement supplied privately authenticated the model
listing with HTTP 200 and 133 models, including `gpt-5`. The private release
configuration selects `openai/gpt-5`. A separate bounded direct inference
preflight returned HTTP 200, successful `stop`, and a nonempty reply using 13
prompt plus 10 completion tokens. Credential/model visibility and direct paid
inference are verified; the public application execution/recovery cycle remains
pending. No synthetic production provider was added. Complete the release scenario:

**Send → execute → idle → preserve → stop → download without waking → send again →
restore → continue the same original conversation.**

Record helper startup, restoration, Gateway process startup, SDK authentication
and dispatch timings separately. Do not collapse provider-free helper/native
proofs into a claimed complete Cloudflare release pass.

## Phase 5 native image verification

The local Linux/amd64 production image
`sha256:ed53cbe22fa65c3f4cff9bd5c6e2e214945dc32249222f9a14ed5c7a24f9d289`
passes the seven existing helper/native preservation checks and the complete
strict followup integration (203,590 ms, four deterministic local provider calls).
Independent review verified actual protected source keys/owner before provider,
later successful causal completion, wrong-scope refusal, process restart, real
helper signed-S3 upload/readback/fresh restore, physical staged groups of two and
65, failed-write provider fencing, lifecycle-revision reset rejection and exact
Stop ACK durability before broad session cleanup. The image's four guarded native
module hashes and baked compatibility manifest were independently verified.
Twenty-one pinned-source/installer cases are separate simulated-storage tests;
they do not substitute for the physical image checks. See
[native compatibility](native-compatibility.md) for the exact patch boundary.

These native-image results are distinct from the application and production
outcomes below.

## Phase 5 / production results

- Implementation commit `5448c77b71131d19f58bb6956843ef28d77ea68c` passed
  943 core tests with six existing skips, type checking, lint, formatting and the
  scoped LOC audit. The complete local acceptance failed at desktop Stop after
  Gateway, media, recovery and twelve desktop cases passed; one input remained
  Unknown. Later mobile/capacity cases were not reached. Remote acceptance also
  failed at the restart control. The draft PR is
  <https://github.com/cikpak/openclaw-task/pull/1>; CI is not green.
- At the user's request, manual deployment proceeded before complete acceptance.
  `568dc77db3394dd4e91aae69a8bd9a6c280c4b48` corrected first image provisioning
  and the same-Worker namespace binding. Backend and Pages deployed successfully;
  D1 migration applied. The production bucket is private, Worker alternate public
  URLs are disabled, and deployed observability disables invocation logs/traces
  and redacts queries. Forty-seven public authentication/routing checks passed,
  including secure cookies, expiry/replay/origin/session checks and logout.
- Manager-only diagnostic commit
  `b37e384236a854e294fb4606f0c76a1d18fd836a` deployed with container rollout
  `none`, version `9cd32993-df8e-4654-bbb9-f3a01b69aeb6`. It logs finite fixed
  startup stages/categories without raw errors, environment or payloads. Its
  scoped types/lint/format and actual build passed; immutable artifacts and
  source were scanned for known private values without findings. The production
  image `84c683c3bcd0ab960f5e81b35af4ab76572ef9df982be9c18cb705cbfce7ddef`
  has the same RootFS and configuration as the tested `ed53` image above.
- An actual standard-2 VM started. Public live model listing returned 31 available
  models including `openai/gpt-5`; cached bootstrap responded in 176 ms. The real
  provider completed a canonical reply with no pending input in about 40.6 seconds.
  The helper uploaded a recovery archive/manifest and the platform subsequently
  reported zero active instances. A later explicit request on that original chat
  also completed after waking again.
- File verification has **not passed**. The first real-provider reply claimed the
  requested marker without a canonical file-writing tool call or a published
  file; an explicit retry also claimed completion without a visible file. Do not
  count text claims as tool execution or a successful download/restore-file read.
  One long-lived verification socket timed out on `files.list`, while a fresh
  socket returned an empty catalogue. The cause remains unproved. The complete
  public send/preserve/stop/download/restore/continue scenario, production restart
  proof and complete browser/capacity acceptance remain open. No lifecycle state
  was cleared and no fallback empty engine was initialized to force readiness.

## Existing broad-test budget exceptions

All targeted/new modules and focused tests meet the approved hard budgets. The
selected changed-file LOC audit records three root/reviewer-approved existing broad
suites: `chat-coordination.test.ts` 1,021→1,025 lines,
`gateway-presentation.test.ts` 314→323, and `server.test.ts` 702→703. Their edits
update existing receipt/readiness assertions; no new cases were added to those
files. New focused coverage remains at most 300 lines/file. These are explicit
baseline exceptions, not a claim that every existing test file is under 300 lines.

The existing `ChatSettingsPanel.tsx` is outside the named service/store/adapter
extraction targets: 493→491 lines, solely removing the condition that hid its
existing Refresh button. No unrelated component decomposition was added.

## Focused repair evidence before deployment

The verification client now rejects closed or failed socket writes immediately
without mutation replay (five focused cases). The supported Codex direct tool
configuration passed official SDK activation, exact unrelated-config preservation,
already-direct no-op and real signed-S3 capture/fresh-helper restore in 76.436
seconds. Actual public model tool execution remains a separate gate.

The rebuilt helper image
`sha256:5d4bd019007bcb085e166ecd146a2f0d7af38556bf9981ed8f4a6c163e3c870c`
passes 48 guarded native-source/installer cases and independent exact verification
of all seven transformed native modules and both installed helper digests.
The separate actual production-method immediate-Stop probe passed: 0.906 ms from
send acknowledgement to Stop, no preflight canonical owner, one exact scoped
pre-execution certificate persisted before mandatory broad cleanup, and zero
provider calls. A nonce-sealed native history read cleared the application pending
row without inventing a USER event or translating an input ID into a generated
owner. Real Gateway stop/start plus twenty observations over 11.413 seconds showed
no replay, active work, native pending or application pending, with zero provider
calls. Owned cleanup and preservation of unrelated containers passed.

Independent focused backend review passes 127 tests, including exact held-history
replacement/new-nonce refusal. These results do not turn the historical failed
aggregate or old deployed image into a pass. Restart control, complete current
acceptance, final-head CI and the public release cycle are still pending.
