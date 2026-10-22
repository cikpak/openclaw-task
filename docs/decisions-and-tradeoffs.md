# Decisions, alternatives and tradeoffs

The approved Cloudflare plan and later explicit user instructions define scope.
This record explains the final choices by area; implementation mechanics are not
new user decisions. The separate Obsidian history retains all 53 original decision
records, 75 tradeoff entries, explicit later revisions and failed experiments.
[Short execution choices](implementation-decisions.md) complement this rationale.

| Area / context                    | Selected approach                                                                                         | Alternative and tradeoff                                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App must work while engine sleeps | Pages plus Backend/D1 and manager DO remain available independently of the container                      | Hosting the whole app with the engine is simpler but makes login/history depend on engine startup                                                                             |
| Authentication ownership          | Backend owns sessions/tickets/grants; DO checks permissions per resource                                  | Manager-local login duplicates authority and complicates immediate revocation; backend checks add private calls and fail closed on outage                                     |
| Socket admission                  | Exact-session/origin/manager single-use 60s ticket before upgrade; renewable grant<=15m                   | Cookie-only manager trust obscures admission boundaries; query tickets require disabling raw URL capture                                                                      |
| Native transport                  | Official browser SDK server-side over native private Fetcher WebSocket; separate private HTTP helper      | Custom TLS adapter failed its trust gate; helper WS bridge adds protocol duplication; public Gateway broadens exposure                                                        |
| Native identity                   | Persist signing identity/device token; exact helper pairing; no silent local approval                     | Arbitrary/latest-device approval or special backend-client bypass is easier but does not prove expected device trust                                                          |
| Readiness / user flow             | Durable acceptance before wake; normal queue UI; dispatch only after verified native readiness            | Disabling Send exposes infrastructure and loses normal offline queue semantics; accepting needs durable intent, fencing and reconciliation                                    |
| Recent history                    | Whole user/assistant messages sized to approximately two viewport screens                                 | Fixed message counts vary greatly by layout/content and must not become native retention limits; measurement requires more metadata                                           |
| Browser privacy                   | Project before stream/cache/replay/error; opaque IDs and explicit publication evidence                    | Directory-only publication and raw tool details expose internal state; missed evidence leaves a file private rather than guessing                                             |
| Sleep consistency                 | 60s genuine idle, renewed suspend lease, stopped writers, capture/verify/commit before destroy            | Browser silence/platform idle alone can lose work; cooperative lease alone cannot prove every writer stopped                                                                  |
| Incoming work                     | Option B cancellation until recorded final stop issuance; use current local files before cutoff           | Always finish stopping increases wait; restoring an old checkpoint over live files loses unsaved changes; cutoff/uncertain stop needs durable serialization                   |
| Recovery packaging                | One tar.gz internal archive plus separate user objects, direct helper↔R2 transfers                        | A monolithic archive makes asleep downloads costly; all-files-as-objects complicates coherent native state; separate objects require manifest/GC consistency                  |
| Preservation coverage             | Unknown meaningful state retained; paths/ownership/modes/deletions and SQLite sidecars verified           | Browser-only publication coverage loses private working state; preserving ACL/xattr/inode/timestamp details would add a stronger filesystem contract outside logical recovery |
| Recovery retention                | Latest completed generation; previous held during replacement; GC respects readers/pending jobs           | Keeping every checkpoint increases cost; eager deletion risks live downloads/uncertain commits; generation-qualified keys fence delayed deletes                               |
| Crash guarantee                   | Restore latest completed generation; no routine engine sync                                               | Continuous journaling/periodic saves could reduce loss but expand cost and consistency scope; unsaved native changes may be lost                                              |
| Uploads                           | Authorized WS staging without wake, existing quotas, session-scoped handoff before native dispatch        | Direct browser engine upload requires engine availability; inline native base64 cannot carry approved aggregate size, so stable private session files bridge it               |
| Downloads                         | Opaque app URL, exact-session single-use 60s Backend permission; live helper or committed R2 asleep       | Direct R2 links bypass required app admission; stale R2 fallback can misrepresent current live data; streaming needs durable reader leases                                    |
| Deployment                        | Manual local Mac cf OAuth; CI checks only; immutable one-commit artifacts and Pages last                  | The plan initially selected manual Actions deployment/new credentials; user explicitly rejected Actions deployment and authorized supplied experiment R2 key reuse            |
| Provider verification             | Exclude original invalid key; privately validate replacement; separate infra evidence from paid execution | Synthetic production responses would falsely claim success; model-list HTTP200 is credential visibility, not a completed paid public release scenario                         |
| Scope                             | One account/manager/container, fresh data; preserve schedules without automatic scheduled wake            | Multi-user allocation, imported deleted data and automatic scheduling need separate policy/cost/recovery designs                                                              |

## Supersession and historical interpretation

Earlier DigitalOcean/Caddy whole-demo decisions and temporary-data guarantees are
historical. Opening a socket no longer wakes the engine (superseding early D09).
The single-all-state-archive selection D32/S24 was explicitly revised to internal
archive plus separate user objects by D35/S27. D53/S45 selects native private
Gateway routing instead of the failed custom TLS route; no current TLS pin is
claimed on the internal connection. Earlier open frontend/backend hosting choices
are resolved by Pages and Workers. Future multi-engine questions remain deferred.

The user-authorized R2 credential reuse changes credential provisioning, not
publication boundaries or resource isolation. Production app data uses a new
private bucket and D1 database; retained experiments are not repurposed. No secret
values belong in documentation, version control, frontend artifacts or screenshots.
