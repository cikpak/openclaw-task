# Release verification

## Current evidence boundary — 2026-10-22

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

## Provider-dependent gate remains open

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

These results do not claim final global tests, the fresh local full aggregate,
GitHub CI, immutable deployment artifacts or public paid-provider execution.
Those outcomes remain below and must be recorded when observed.

## Phase 5 / production results

Pending final integration and release verification. The release operator must
record the commit/artifact identity, local harness result, GitHub PR/CI outcome,
public Pages origin, fresh/repeat deployment outcome, active-engine manager restart,
private binding/URL settings, cookie/admission/replay/logout checks, SPA/API routing,
frontend secret scan and sanitized sentinel logging audit. Report any blocked or
failed check explicitly. Infrastructure availability and provider execution are
separate outcomes.

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
