# Implementation decisions

Short execution decisions recorded while implementing the approved Cloudflare plan.

## Phase 2: authorization and transport

- The single prototype account is `owner`, assigned to manager `primary`. These identifiers remain server-side allocation records; the backend owns assignment.
- The opaque session cookie is `__Host-messenger_session`, with Secure, HttpOnly, SameSite=Lax and root path. D1 stores only a SHA-256 hash of its random 256-bit value.
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
- Manager Ed25519 identity, issued device token, helper token and Gateway token persist in Durable Object storage. Helper approval matches only the exact expected identity and operator scopes. Client metadata uses `gateway-client` / `cli` without the special local-backend pairing bypass; automatic local pairing is disabled.
- Browser connection readiness describes the authorized manager transport. Sleeping/warming native connections cannot disable Send; accepted work survives browser logout. Native dispatch closes before suspend preparation and reopens only after local readiness/reconciliation.
- Newly accepted chats are durable creating intents. Materialization recovers the deterministic native agent identity before creating it, records uncertain creation, and saves confirmed mappings before queued dispatch.
- The helper runs as root and Gateway as uid/gid1000, allowing recovery to preserve original ownership/modes. All meaningful HOME/state/workspaces reside beneath `/recovery`; helper control, staging and its compile cache live outside that snapshot root.
- Each generation uses one internal tar.gz archive plus separate content-addressed `files/<sha256>` objects. Unknown private files outside documents remain in the archive. Object separation never grants browser publication. SHA256 checks verify complete objects; multipart/ordinary ETags are never treated as content hashes.
- Capture preserves safe symlinks and hard-linked file contents; escaping links and special files fail closed. Hard-link inode identity, filesystem timestamps, ACLs and xattrs are outside the logical state contract. SQLite validation uses expendable pinned-Node clones including sidecars.
- Sleep starts after 60 seconds of genuine idle. Native prepare renews its 120 second lease. Helper jobs poll at 1-second intervals with durable boot/attempt IDs and 15 minute absolute deadlines. Preservation failures retain local disk and the prior reference, restart locally when safe, and back off 30 seconds; arriving work expedites cancellation.
- Cancellation remains allowed until the durable stop-issued fence immediately preceding platform destroy. Cancellation tombstones prevent late helper starts, and upload composition cannot begin a later stage after cancellation. Uncertain stop finishes before any restore.
- Initial defaults require proven pristine state. An initialized engine without a checkpoint after disk loss fails closed. Container running, Gateway process running and authenticated usable Gateway are distinct readiness states.
- Safe projection precedes history and stream caches. Native internal/tool frames remain private until an authoritative deliverable classification supports a concise summary. Truncated completed native messages are rehydrated through the native message API, then an exact-session private transcript fallback; transport caps do not define conversation retention.
- Helper metadata operations check available runtime capacity; preservation file bytes have no browser-upload or experiment fixture size/count cap. Insufficient capture capacity fails safely without destroying the current disk.

- Recovery readback refreshes platform supervision every 20 seconds outside the serialized lifecycle step; a 10-minute verification deadline stays below the 15 minute platform watchdog. Arriving work cancels on the next stream chunk.
- Full-message helper imports use named exports from the immutable image's own bundles. NPM distribution bundle hashes differ despite the same version; image/SDK upgrades must rerun exact long-message recovery verification. Native message-API transport failures can use the same exact-scope safe fallback.

- Writer drain verifies all live engine-UID processes and writable recovery descriptors across `/proc`, including detached process groups. Remaining writers fail closed; the helper never kills unrelated processes. Configured workspaces cannot resolve into excluded cache/tmp trees.

## Phase 4: files, safe history, and browser integration

- File cards use a single 60px-minimum row with fixed size/icon and an ellipsized filename, retaining the full accessible name and original download filename. Positive line/column citations are stripped only from exact audited publication aliases; exact opaque inline-code references use the same authenticated resolver as Markdown links. Fenced code and private/unclassified paths remain inert.
- Ordinary file requests need agent-facing publication guidance on every turn. Native input preparation persists a submission-specific private appendix before the final dispatch ownership check; exact stored context is stripped from public history. This preserves Stop, queue/receipt identities, user text and existing sessions. Root-level files remain private, and publication still requires a successful eligible native write/edit. The first AGENTS.md-only fix failed the real existing-chat browser flow because pinned Codex bindings freeze their initial workspace instructions; that attempt remains historical evidence rather than a claimed pass.
- Application data now travels through authorized manager WebSockets. Authentication, admission tickets, and separately authorized opaque downloads retain HTTP.
- R2 uploads reserve the existing per-account quota before accepting bounded chunks; acknowledged content and metadata survive manager reconstruction. Accepted attachment references are bound transactionally to their intended chat.
- Native media handoff uses stable private session files because the pinned protocol only supports inline base64 and cannot carry the approved aggregate size. The exact submission-specific appendix is retained privately and removed from public history. Native image reads were verified in the pinned image.
- Deliverables require successful eligible write/edit evidence and a verified documents path. Credential scans, stopped-writer audits, and exact digest matching protect live and committed downloads. Mere placement never publishes unknown files.
- Downloads use backend-issued single-use, exact-session permissions lasting 60 seconds. Admitted streams outlive authentication changes; independent durable reader leases delay final stop and cleanup. A stalled stream has a 90-second inactivity timeout.
- The safe history cache uses measured viewport dimensions and whole messages. Native sequence anchors preserve older-page navigation when new messages arrive. Completed replies travel in ordered fragments without truncation.
- Unchanged hidden settings and queued text preserve their canonical private values. Partial edits containing redaction placeholders return a controlled error rather than overwrite hidden work.
- New recovery user objects use generation-qualified immutable keys. Only exact currently committed objects may be reused, preventing late cleanup from deleting a later incarnation after restart.
- Upload command identity records retain compact SHA-256 fingerprints; legacy records migrate on verified replay. This preserves ownership/reuse fences without storing upload base64 outside its retention quota.

Validation includes actual Workers/D1/R2 upload and download admission, delayed and uncertain cleanup, reader pins, native SDK authentication and image reads, stable native pagination, complete 2.53-million-character replies, and real desktop/mobile cached access without an engine binding. At that phase handoff, real execution was blocked by the unavailable valid key. A replacement later passed private model-list validation; a bounded direct paid inference also passed, while the actual public application cycle remains pending. No synthetic production provider was introduced.

- Input files use the same publication checks as generated deliverables. The complete known-secret set stays DO-only during upload/DTO scanning. Helper file audits use only container-local credentials and the issued native device token; R2 credentials and manager private signing material never enter the container. Upload completion rejects known server secrets; changed handed-off inputs are audited before capture and bound to their verified digest. Failed publication audits preserve meaningful private bytes while disabling both existing download permissions and stale staging fallback.
- Successful native write classification keeps minimal private durable start/result evidence across manager reconstruction. Files whose relevant events were entirely unobserved stay private until later explicit verified publication evidence.

## Phase 5: workflow and documentation

- The Node server is a decomposed compatibility/test adapter. Current local
  development uses the Cloudflare harness plus separate frontend Vite, superseding
  the Phase 2 transitional Node-development entry.
- Manual deployment uses immutable one-commit Worker, container and compiled Pages
  artifacts. CI checks only; user instructions supersede the earlier Actions plan.
- Preserve earlier repository operating instructions under `docs/history/`, clearly
  superseded. Keep Obsidian original decision/tradeoff/research bodies intact and
  archive replaced current pages verbatim; publish the current October 22 light diagram.
- Keep release evidence separate from historical phase passes and provider-free
  tests. Private model-list credential validation and actual paid public execution
  remain separate release gates.

- PDF input handoff uses the pinned image's native extractor in an isolated
  uid 1000 process. Private text/PNG companions bypass binary-read/base64 limitations;
  source snapshots and exact original bytes remain intact. Incomplete extraction
  fails explicitly; companion publication is forbidden. Image upgrades must
  revalidate this narrow private-module compatibility dependency.

- Canonical attachment history retains original upload ID, name, MIME type and size
  through exact session/submission/marker provenance after removing the private
  native handoff appendix. Retried submissions cannot mutate that original metadata
  or expose helper paths.

- First-use attachment import creates only an absent documents directory as a
  credential-free UID/GID 1000 child through a pinned workspace descriptor. Existing
  directory ownership/modes are never rewritten; protected input descendants stay
  root-owned. Retained descriptor leases fence root mutations and asynchronous PDF
  work against outside-root races.

- A caller joining in-flight reconciliation requests a subsequent owned pass,
  preventing newly accepted work from being stranded behind a completed chat scan.
  Native terminal output is not proof of durable input execution: unresolved text
  remains in recovery and successors wait for exact receipt reconciliation.
- Invalid manager bodies echo only a valid UUID correlation, allowing the browser
  to settle its command without reflecting arbitrary rejected payload. Unsupported
  uploads keep the existing 415 result and create no quota/ownership/staging state.

- Recovery verification stays entirely on the helper data path: signed GET
  readback checks all new/reused objects, then returns an exact-object-tuple digest.
  The DO validates that constant-size receipt and HEAD metadata only; recovery
  bodies never cross it. This corrects the earlier implementation to match the
  approved archive boundary without weakening whole-object integrity checks.
- Three pre-existing broad test suites retain documented, reviewed LOC exceptions;
  only existing assertions/readiness waits changed, with no new cases there.
  Targeted/new modules and focused tests keep the approved hard budgets.

- Native ingestion alone cannot settle accepted execution. Private exact-session
  user identity (stable event ID and positive sequence) must resolve the input's
  direct/steered owner, followed by a later successful same-owner canonical final
  with no tools/error or active owner. Explicit pending evidence wins; interrupted,
  length-limited and provider-error outcomes remain uncertain. This supersedes the
  earlier user-journal-only reconciliation assumption.
- Explicit Stop/cancel-work records scoped row/revision/submission/owner intent
  before invocation and confirms only a matching persisted native abort ACK.
  Fresh owner/session/row checks fence settlement; lost/no-active ACKs, raw native
  cancellation and later work do not acquire cancellation authority.
- Fresh Steer saves effective behavior and the ready active target before ACK,
  retaining exact target/revision intent across reconstruction without retargeting.
  Unknown-delivery fences remain stronger than queued/steered dispatch.

- The pinned native queued-followup owner gap uses dedicated private processing
  metadata, never `steerTargetRunId`, text/adjacency inference or `agent.wait`
  admission status. Exact recorder source keys persist at the existing native
  timing; the selected built-in provider cannot run without committed proof.
  Version/seven-module hashes and unique anchors are validated before writes,
  with a baked before/after manifest. Native scheduling, admission and commands
  remain unchanged. See [compatibility contract](native-compatibility.md); physical/native/full-acceptance gates remain
  separate from simulated-storage prototype coverage.

- Generated followup cancellation uses the existing official exact-run selector,
  persists only a matching execution ACK before another await, then retains the
  original broad session queue/cascade cleanup. Grouped owners are deduplicated;
  targeted errors do not skip broad cleanup. Logical input ACKs are never mapped
  to execution authority, and all original scope/revision/new-work/retry fences
  remain. The strict actual image probe separately verifies durable proof before
  the broad call and pending settlement; full browser/CI release gates still apply.

- Immediate Stop before native USER persistence uses a separate typed scoped
  pre-execution certificate from the existing official chat abort response.
  Eligibility retires at native deferred/adopted handoff; execution, queued work,
  controller replacement and foreign manager admissions cannot qualify. The
  original nonce/tuple/scope and fresh inactivity/owner checks fence consumption.
  Generic IDs still require canonical owner equality, and broad cleanup always
  follows. A null ACK, model text or inactivity alone never proves cancellation.
- The supported Codex direct dynamic-tool-loading field is activated through a
  fresh hash-checked native config patch and verified applied revision before
  dispatch. Tool permissions and model selection remain unchanged. Unapplied
  configuration stays fenced; no automatic non-CAS plugin reload can apply an
  unrelated concurrent revision.

- Test teardown permits only exact code-1 Docker removal-in-progress/not-found
  responses to settle before a fresh final absence proof. Every removal still
  checks the unique owned namespace; permanent/unknown/timeout errors remain
  fatal, and ports plus unrelated-container preservation remain mandatory.
  Safe finite error categories are retained because the original discarded
  Docker stderr cannot prove the historical cause. This changes test cleanup
  only; the deployed a65 application and helper artifacts remain unchanged.

- Actual CI proved a teardown deadline boundary: the 87c2ccf push aggregate passed,
  settling Docker removal near 29.5 seconds, while the PR aggregate passed every
  product stage but still observed only removal-in-progress at 30 seconds. Allow
  sixty seconds for those classified test-only responses, keeping the fifteen
  second command timeout, all permanent errors and final absence checks unchanged.
  Regression coverage includes success at 30.25 seconds and failure at sixty.

- The 0301cbe PR browser run observed a 44px notification button as
  43.99999237060547px; its trace retained the existing 44px minimum CSS target.
  Allow only 0.0001 CSSpx of geometry measurement noise in the test helper.
  Visibility, a non-null box and the 44px width/height requirement remain; actual
  Chromium regressions prove 43.99px and 43px controls still fail. This changes
  test precision only, with no production CSS or application change.
