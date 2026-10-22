# Native processing and cancellation identity

OpenClaw 2026.10.1 can accept a logical input under its client UUID, then execute
that input through a queued followup with a newly generated run UUID. Its public
ACK retains the client UUID. The canonical user input may have neither that
execution UUID nor a confirmed steering target. Consumption means ingestion,
and a client `agent.wait` status can reflect queue admission, so neither proves
that the requested work produced a successful result.

The pinned image applies a guarded compatibility patch at build time. It records
the actual admitted followup execution owner in dedicated private canonical
metadata. It preserves queue selection, scheduling, permissions, provider
selection, replay, cancellation and native admission timing. All native commands
continue through the official Gateway SDK.

## Exact association

`__openclaw.messengerProcessing` contains `runId` and the complete `keys` array
from the exact native source recorder frames. The native manager client marker
limits the addition to Messenger-originated inputs. Unkeyed and unmanaged
native inputs retain their existing behavior. Grouped and overflow followups
retain every original protected input key; the association does not come from
message text, neighboring records, last-run state, or a copied client field.

Before entering the existing followup execution callback, the recorder captures
this private plan. Already canonical inputs await the native exact-anchor
rewrite and publication. Staged input bytes and their approval hashes remain
unchanged. Ordinary native persistence commits the canonical input at its
existing point, then awaits the exact owner metadata rewrite. Protected metadata
restoration preserves the plan across runtime and message hooks, including
hooks that mutate the original object in place.

The existing built-in provider persistence barrier checks the committed proof
before calling its underlying provider stream. Missing, cancelled,
contradictory, stale-generation, failed-write or failed-publication proof cannot
silently reach that provider. Confirmations serialize within one recorder;
asynchronous writes capture immutable proof, key and exact admission ownership.

The application still requires the original durable native session, an exact
stable canonical USER association, and a later stable same-owner ASSISTANT with
a successful final stop, no error/tool flags, and the owner inactive. Native
pending authority continues to fence completion. A newer explicit native retry
association supersedes an older association or base-key fallback; equal-sequence
contradictory owners fail closed. Metadata alone never completes accepted work.
Unknown outcomes remain visible without automatic replay. The private field is
excluded from browser snapshots and messages.

`steerTargetRunId` is deliberately not reused: upstream capability and display
logic assigns it additional steering semantics.

Explicit Stop/cancel-work uses the official exact-run `sessions.abort` selector
for the proven execution owner and immediately persists its matching ACK. The
original key-only queue/cascade cleanup still follows, including after target
failure. The logical input ACK from that broad action is never translated into
an execution ACK. Row/revision/submission/original-session and fresh-owner fences
remain necessary; lost, warning, no-active or mismatched proof stays uncertain.
Generic IDs from the richer official `chat.abort` response likewise require a
fresh unique canonical owner equal to the raw ID.

## Cancellation before execution

An immediate Stop can cancel native input before its first canonical USER record
exists. The existing broad session cleanup may return a null execution ID; a
boolean cancellation response or subsequent inactivity cannot identify that input.
The guarded image extension adds a private typed fact to the existing official
`chat.abort` response for this precise native phase.

Only an exact Messenger followup admission is eligible. The helper records the
original input, native session, agent and controller in a private WeakMap. Native
deferred/adopted callbacks retire eligibility permanently. Immediately around the
original synchronous successful abort, the helper requires the same original
controller and scope, no started execution or queued turn, an aborted signal and
native registration cleanup. Expected controller removal is permitted; controller
replacement is rejected. Native return values, scheduling, permissions, abort
behavior and provider admission remain unchanged.

The resulting `pre-execution-input-cancelled` certificate is distinct from ordinary
abort IDs. The application stores it under the originally captured Stop nonce and
pending-row identity. Only that typed certificate can settle without a canonical
USER, after fresh history confirms the original scope, no pending/active native
work and no contradictory canonical association or known generated execution
owner. Resets, replacement requests and stale asynchronous reads cannot inherit
its authority. It is never projected to the browser.

Exact-owner aborts and immediate execution receipts remain first. The richer
official abort follows, then the original broad queue/cascade cleanup always runs,
including when either earlier operation fails. Unsupported or missing proof keeps
the outcome uncertain.

## Pinned build guard

The production and acceptance Dockerfiles invoke the same installer. It verifies
the package version and every original module SHA256 before writing any module,
then requires exactly one occurrence of every insertion context. Unknown native
bytes, another version, or ambiguous/missing contexts fail the image build.

| Native module                                | Original SHA256                                                    |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `chat-send-handler-MxN0361b.mjs`             | `654bd764ae5a38bed1986de3eb704622b539df92ea1f60cb8744245e1f5b27b2` |
| `chat-abort-runtime-HvpXWrR-.mjs`            | `29cf6878f940b3c909afcbf8ce984c5f8bb3a3d8103cd33c64b1371ab18bfa5e` |
| `chat-abort-handler-csuIgsSO.mjs`            | `5a3c92d2fb406d480e79dc1ac7408f6a32665bcc7d846e11f04811608a5241cd` |
| `agent-runner.runtime-BilVGTOB.mjs`          | `9dde4b1bd91a2147384ba2ea074c33e28fc7c1f7d30179b4a47250595cc33568` |
| `user-turn-transcript-DkAE8Np5.mjs`          | `ac1a25cd70f525882d02a03d8b696a36964dec62f4d86315d043cf2753b8b1c9` |
| `user-turn-transcript.metadata-DfqiJdv-.mjs` | `6fd6225662459f11f9cfeed1774975b9e4b91406ec634c2aba8d2aed54e98297` |
| `builtin-openclaw-CEs0yxf2.mjs`              | `f2ff79ffff99ab8e58cb54cefae0628a1b44c5b3a5ff027c2a8eb95182f763c7` |

The immutable image contains `/app/dist/messenger-compatibility.json`: upstream
version, every before/after module hash and both companion helper hashes.
There is no runtime patch mount, new RPC, arbitrary SQL/path selector, helper
bridge or public diagnostic endpoint. Upstream upgrades require explicit source
review, revised guards, a new image and the full native/acceptance gates.

## Validation

`test/helper/native-owner*.mjs` executes the actual hash-verified native recorder,
metadata restoration and provider wrapper code with simulated storage/custody.
These focused prototypes verify ordering, immutable staged bytes, cached source
objects, full grouped-key plumbing, failure fencing and atomic installer guards.
They do not substitute for physical native SQLite/custody validation.

`test/helper/input-cancellation*.mjs` additionally verifies exact admission and
abort anchors, irreversible retirement, execution/queue/replacement negatives and
the all-module zero-write installer guard. The fact-only physical image diagnostic
observed the exact scoped certificate at the real immediate send/Stop boundary,
zero provider calls and no replay across a real Gateway restart with twenty SDK
observations. That first diagnostic intentionally left application settlement unchanged. A
separate actual production-method probe then persisted the scoped certificate
before mandatory broad cleanup, cleared the application pending row through a
nonce-sealed history read, and retained zero provider calls or replay after a
real Gateway restart and twenty SDK observations. This is bounded native/app
proof; full browser, CI and public release verification remain separate gates.

The image integration probe validates actual staged/grouped custody and physical
generations. Release also requires genuine late-fallback SDK execution, proof
visibility after restart/recovery restore, explicit Stop/cancel-work, all native
preservation probes, and the normal complete browser/capacity acceptance run.
