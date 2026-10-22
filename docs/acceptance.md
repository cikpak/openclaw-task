# Acceptance coverage

This matrix describes implemented behavior and verification boundaries, not a
blanket release pass. [Release verification](release-verification.md) records
observed results and the pending real-provider execution gate. [Historical assessment
coverage](history/pre-cloudflare-acceptance.md) retains earlier requirements and
results without treating the old topology as current.

| Area                         | Current evidence / implementation                                                                                                               | Boundary                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Session and admission        | Actual workerd/D1 tests cover opaque sessions, atomic ticket use, exact session/origin/manager, renewal/revocation and backend-failure denial   | 60s connection tickets; grants<=15m/session; logout cannot cancel accepted agent work                            |
| Durable queue / ownership    | SQL process-restart, replay/fingerprint/receipt and per-resource tests; frontend durable-ack regression                                         | Wake beyond15s does not trigger generic resubmit; unknown native outcome is not automatically replayed           |
| Native device authentication | Actual pinned SDK/Docker exact pairing, incorrect identity denial, issued-token reuse and restart continuity                                    | Does not replace Backend user authorization or constitute provider execution                                     |
| Lifecycle / preservation     | Durable phase/fence/race tests, writer drain, actual helper capture/restore and realR2 fresh-helper restore                                     | Latest completed generation crash guarantee; failed save keeps local state; failed restore keeps Gateway stopped |
| History / no wake            | Actual Chromium with Workers/D1/DO and no container binding; measured desktop/mobile whole-message cache                                        | About two screens, no fixed count; older uncached requests may wake                                              |
| Complete replies             | Actual pinned native 2.53M-character rehydration and ordered fragment tests                                                                     | Native transport/display caps are not retention caps                                                             |
| Privacy / tools / files      | Before-cache projection, secret/chunk-split scanning, explicit write classification, document-root/inode checks, helper secret-role regressions | Raw tool details/internal file activity never become browser data; unknown/missed file evidence remains private  |
| Uploads                      | Actual Workers/R2 bounded 5 MiB restart, quota/ownership/retention tests, native 10 MiB aggregate handoff and image read                        | Browser5file/5 MiB/10 MiB limits never cap preservation                                                          |
| Downloads                    | Actual exact-session single-use 60s permissions; logout-completing streams; current-input denial, reader pins and uncertain GC tests            | Asleep/restore delivery uses audited committed R2 without wake; no stale live fallback or direct R2 URL          |
| Responsive frontend          | Component/store/transport checks plus actual Chromium desktop/mobile cached access                                                              | Physical devices/non-Chromium and final provider-dependent production loop remain separate                       |
| Deployment / routing         | Pages facade/private binding configuration and Phase 5 checks                                                                                   | Final public origin, CI and fresh/repeat deployment results must be observed and entered in release record       |

## Existing functional contract

Independent chats, model selection and per-chat overrides, route-stable drafts,
streamed Markdown, queue position edits, steer/abort/cancel, settings version guards,
custom instructions/style/personality and recoverable uncertain delivery remain in
scope. Ten visible chat capacity and20 pending messages/chat are preserved.
Deleting a chat retains tombstones/receipts; it is not complete storage erasure.
Tool restrictions are not an OS sandbox. General arbitrary native configuration
editing remains outside the UI: Config Generator is still partial.

Device Authentication, concise safe Tool Call Display and bounded Image Attachments
remain supported. Raw tool popovers from the earlier implementation are not a
privacy entitlement; only approved browser-safe summaries and opaque files cross
the manager boundary. Paid-provider interpretation, scanned-PDF quality and
external web-fetch output require separate provider checks.

## Release gate

Run the complete public-origin sequence with a valid private provider: send,
execute, idle, preserve, stop, download without waking, send again, restore and
continue the original conversation. Record startup/restore/auth/dispatch separately.
Replacement credentials passed private model-list validation; no complete paid
public-provider pass is claimed until the actual sequence succeeds.
