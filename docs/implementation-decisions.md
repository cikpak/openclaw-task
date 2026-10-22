# Implementation decisions

Short execution decisions recorded while implementing the approved Cloudflare plan.

## Phase 2: authorization and transport

- The single prototype account is `owner`, assigned to manager `primary`. These identifiers remain server-side allocation records; the backend owns assignment.
- The opaque session cookie is `__Host-messenger_session`, with Secure, HttpOnly, SameSite=Lax and root path. D1 stores only a SHA-256 hash of its random256-bit value.
- Each manager operation rechecks its grant with the backend, in addition to per-resource ownership. This favors immediate authoritative logout enforcement and failing closed during backend outages.
- Download permissions are independent of their originating socket grant after issuance. Admission still atomically consumes the permission and checks the exact original live session. Admitted transfers can finish after logout.
- Production observability records controlled route names, generated correlation IDs and status only. Invocation logs and request traces are disabled because download permissions occur in paths and connection tickets occur in queries; query redaction alone cannot protect both. Query-string redaction is also explicitly configured.
- Auth renewal and engine lifecycle share a persisted scheduler with named deadlines. The earliest deadline owns the Durable Object's sole alarm.
- The legacy Node development server temporarily permits its existing cookie-only WebSocket callers. Its browser now uses fresh single-use tickets; the production Manager always requires backend ticket admission.
- Cloudflare's verified cf/config build uses pinned beta tooling. The harness facade is private in deployment configuration, and forwards only explicit public dynamic routes through service bindings.
- Root workspace tests run one package suite at a time. Running frontend DOM polling, legacy scrypt/database tests and multiple real workerd processes concurrently exceeded existing timeout budgets on this Mac; serial package execution keeps all assertions and deadlines intact.
- The first deployment has an explicit `backend-bootstrap` build mode that omits the reverse Manager binding. Public login and ticket issuance remain unavailable until the complete Backend binding is deployed.

## Phase 3: native engine and preservation

- OpenClaw and the official browser Gateway SDK are pinned to 2026.10.1. The SDK runs inside the manager over the private native container Fetcher WebSocket. Browser HTTPS/WSS remains public; Gateway and helper HTTP ports remain private.
- Manager Ed25519 identity, issued device token, helper token and Gateway token persist in Durable Object storage. Helper approval matches only the exact expected identity and operator scopes. Client metadata avoids pinned native local-backend/CLI pairing bypasses; automatic local pairing is disabled.
- Browser connection readiness describes the authorized manager transport. Sleeping/warming native connections cannot disable Send; accepted work survives browser logout. Native dispatch closes before suspend preparation and reopens only after local readiness/reconciliation.
- Newly accepted chats are durable creating intents. Materialization recovers the deterministic native agent identity before creating it, records uncertain creation, and saves confirmed mappings before queued dispatch.
- The helper runs as root and Gateway as uid/gid1000, allowing recovery to preserve original ownership/modes. All meaningful HOME/state/workspaces reside beneath `/recovery`; helper control, staging and its compile cache live outside that snapshot root.
- Each generation uses one internal tar.gz archive plus separate content-addressed `files/<sha256>` objects. Unknown private files outside documents remain in the archive. Object separation never grants browser publication. SHA256 checks verify complete objects; multipart/ordinary ETags are never treated as content hashes.
- Capture preserves safe symlinks and hard-linked file contents; escaping links and special files fail closed. Hard-link inode identity, filesystem timestamps, ACLs and xattrs are outside the logical state contract. SQLite validation uses expendable pinned-Node clones including sidecars.
- Sleep starts after60seconds of genuine idle. Native prepare renews its120second lease. Helper jobs poll at1second intervals with durable boot/attempt IDs and15minute absolute deadlines. Preservation failures retain local disk and the prior reference, restart locally when safe, and back off30seconds; arriving work expedites cancellation.
- Cancellation remains allowed until the durable stop-issued fence immediately preceding platform destroy. Cancellation tombstones prevent late helper starts, and upload composition cannot begin a later stage after cancellation. Uncertain stop finishes before any restore.
- Initial defaults require proven pristine state. An initialized engine without a checkpoint after disk loss fails closed. Container running, Gateway process running and authenticated usable Gateway are distinct readiness states.
- Safe projection precedes history and stream caches. Native internal/tool frames remain private until an authoritative deliverable classification supports a concise summary. Truncated completed native messages are rehydrated through the native message API, then an exact-session private transcript fallback; transport caps do not define conversation retention.
- Helper metadata operations check available runtime capacity; preservation file bytes have no browser-upload or experiment fixture size/count cap. Insufficient capture capacity fails safely without destroying the current disk.

- Recovery readback refreshes platform supervision every20seconds outside the serialized lifecycle step; a10minute verification deadline stays below the15minute platform watchdog. Arriving work cancels on the next stream chunk.
- Full-message helper imports use named exports from the immutable image's own bundles. NPM distribution bundle hashes differ despite the same version; image/SDK upgrades must rerun exact long-message recovery verification. Native message-API transport failures can use the same exact-scope safe fallback.

- Writer drain verifies all live engine-UID processes and writable recovery descriptors across `/proc`, including detached process groups. Remaining writers fail closed; the helper never kills unrelated processes. Configured workspaces cannot resolve into excluded cache/tmp trees.

## Phase 4: files, safe history, and browser integration

- Application data now travels through authorized manager WebSockets. Authentication, admission tickets, and separately authorized opaque downloads retain HTTP.
- R2 uploads reserve the existing per-account quota before accepting bounded chunks; acknowledged content and metadata survive manager reconstruction. Accepted attachment references are bound transactionally to their intended chat.
- Native media handoff uses stable private session files because the pinned protocol only supports inline base64 and cannot carry the approved aggregate size. The exact submission-specific appendix is retained privately and removed from public history. Native image reads were verified in the pinned image.
- Deliverables require successful eligible write/edit evidence and a verified documents path. Credential scans, stopped-writer audits, and exact digest matching protect live and committed downloads. Mere placement never publishes unknown files.
- Downloads use backend-issued single-use, exact-session permissions lasting 60 seconds. Admitted streams outlive authentication changes; independent durable reader leases delay final stop and cleanup. A stalled stream has a 90-second inactivity timeout.
- The safe history cache uses measured viewport dimensions and whole messages. Native sequence anchors preserve older-page navigation when new messages arrive. Completed replies travel in ordered fragments without truncation.
- Unchanged hidden settings and queued text preserve their canonical private values. Partial edits containing redaction placeholders return a controlled error rather than overwrite hidden work.
- New recovery user objects use generation-qualified immutable keys. Only exact currently committed objects may be reused, preventing late cleanup from deleting a later incarnation after restart.
- Upload command identity records retain compact SHA-256 fingerprints; legacy records migrate on verified replay. This preserves ownership/reuse fences without storing upload base64 outside its retention quota.

Validation includes actual Workers/D1/R2 upload and download admission, delayed and uncertain cleanup, reader pins, native SDK authentication and image reads, stable native pagination, complete 2.53-million-character replies, and real desktop/mobile cached access without an engine binding. A real provider execution cycle remains blocked by the unavailable valid provider key; no synthetic production provider was introduced.

- Input files use the same complete exact known-secret set as generated deliverables. Upload completion rejects known server secrets; changed handed-off inputs are audited before capture and bound to their verified digest. Failed publication audits preserve meaningful private bytes while disabling both existing download permissions and stale staging fallback.
- Successful native write classification keeps minimal private durable start/result evidence across manager reconstruction. Files whose relevant events were entirely unobserved stay private until later explicit verified publication evidence.
