# Architecture

The browser talks to the backend over same-origin REST and one authenticated
conversation WebSocket. Caddy serves the React app and proxies application routes.
The backend uses the official pinned OpenClaw Gateway client over TLS with a
certificate fingerprint. OpenClaw alone receives model-provider keys.

SQLite stores sessions, chat mappings, application preferences, unsent messages,
submission intent and receipts, pending settings, and upload metadata. OpenClaw
owns submitted messages, execution, transcripts, and workspaces. Frontend stores
are display projections and route-stable drafts, never authoritative queues.

The shared contract package contains browser-safe types. Import rules reject
frontend runtime access to backend implementations, Node built-ins, and Gateway
packages, and require type-only contract imports. Zod validates configuration,
inbound requests, consumed Gateway subsets, persisted records, and outbound
HTTP/WebSocket envelopes; malformed outbound frames close safely without exposing
payloads or validation internals.

Each visible chat maps to an independent agent and canonical main session. A
hidden `main` baseline agent occupies no visible slot. Capacity reservations and
queue mutations use transactions; network operations run outside transactions.
There is one backend process and one dispatcher per chat, not a distributed worker
system.

Agent creation/recovery/deletion serializes the pinned Gateway's shared
configuration mutation and canonical-session initialization. Per-chat message
dispatch remains independent, so ten configured agents can execute concurrently
without overlapping configuration reloads corrupting initialization.

Submission intent is persisted before RPC submission. A transport timeout is an
unknown outcome; recovery consults authoritative submission receipts. Reconnect
uses bounded snapshots, with connection generations preventing stale writes.
Accepted work continues when a browser disconnects or logs out.

An accepted queued edit changes content/revision at its existing position.
Claimed or submitted input is no longer an editable unsent item. Settings apply
after the selected chat becomes idle, or cancel that chat's active/queued work
before applying; the mutation guard fences incoming work during application.

Mutation command identities, request metadata, recovery receipts and creation/
deletion tombstones remain durable after chat deletion. They prevent a delayed
browser retry from creating another agent or replaying cancelled/consumed work.
Deleting a chat removes its application projection/queue and confirmed Gateway
agent/workspace, but does not promise complete erasure of SQLite/WAL, retained
receipts, backups, or all upstream media. Snapshot/history read commands are
ephemeral and old persisted read-cache entries are removed during migration.

Recent Gateway history requests ask for up to 50 messages and 256 KiB; older pages
use authoritative offsets. Live text previews cap at 262,144 JavaScript characters
with a visible truncation flag; canonical execution/history remains upstream.
Snapshots include the oldest 20 unsent items plus the oldest 21 submitted/recovery
items, with a count of additional retained items across both windows. Resolving
visible recovery items or finishing work reveals the next items without evicting
accepted content. Tool storage retains
100 records per chat, with 4,096-character arguments and 8,192-character outputs.
Slow outgoing sockets close for authoritative resynchronization. Frontend startup
refreshes the catalog then individual snapshots sequentially, keeping each frame
bounded; old chat projections, drafts, model scopes and tool watermarks are cleared
after confirmed deletion. Input text remains limited to 32,000 characters within
a 256 KiB JSON/WebSocket transport budget.

Application login uses asynchronous salted scrypt and an encrypted cookie with a
SQLite revocation record. Each HTTP request and WebSocket command validates the
session. Logout and expiration close sockets. Operational failures use one safe
RFC 9457 converter; upstream detail, secrets, paths, and stacks stay on the server.
Direct development ignores forwarded client-address headers; Compose enables only
its single trusted Caddy hop. Provider keys remain in OpenClaw, and the browser
receives only public model capabilities.

Device bootstrap exchanges public data only. The backend persists its private
identity in its data volume and publishes its public identity into a small shared
bootstrap volume. OpenClaw publishes its certificate fingerprint there. The helper
approves an exact identity/role/scope match through the bundled device CLI. The
helper does not choose the latest arbitrary request or disable authentication.

Tool policy explicitly allows workspace file read/write/edit and web fetching.
It disables elevated and cross-agent access. This limits supported tool behavior,
but the agent workspace alone is not a hard operating-system sandbox.

Uploads use opaque IDs and generated paths. The backend checks content signatures,
ownership, limits, model capabilities, and retention before submission. Artifact
downloads require a chat-bound identity and never fetch a user-provided URL.

Attachment admission while online verifies the selected model's scoped capabilities.
An offline admission can use the last verified catalog only for that exact agent,
session and selected model; creation seeds this cache, which is bounded to ten
scopes and 500 models per scope and removed on confirmed deletion. A restarted
backend with no cache returns `ATTACHMENT_CAPABILITIES_UNAVAILABLE`, preserving the
draft and upload. Dispatch always checks fresh scoped capabilities before loading
bytes and calling the Gateway. Incompatible or definitely unsent inputs remain
editable pending work; uncertain delivery retains content for receipt recovery.

The application allows five attachments, 5 MiB each and 10 MiB per message,
subject to negotiated Gateway/base64 limits. Unused uploads expire after one hour;
accepted queue/recovery references retain bytes until resolution. Per-account
temporary/retained upload storage is bounded to 100 MiB and 200 uploads. TXT,
Markdown, text PDF and PNG consumption have actual-Gateway fixtures. Scanned PDFs
may depend on the pinned extractor's image fallback and image-capable model.
Native inline image artifacts transfer at most 5 MiB; URL-only and preview-only
artifacts are not exposed as downloadable files. An ordinary workspace document
write is not automatically a native transferable artifact in the pinned runtime.
The backend additionally mounts only the Gateway volume's `workspace` subpath,
read-only (not Gateway configuration or credential directories). A bounded catalog
lists supported generated files within the exact selected agent/session mapping.
Downloads reject traversal, symlinks, hardlinks, hidden/bootstrap/private paths,
and files over 5 MiB. Opaque scoped identities use authenticated artifact routes;
Markdown file references first resolve against this chat's permitted catalog.
Relative `sourcePath` metadata never exposes server-absolute filesystem paths.
The generated-file bridge requires Linux/Docker directory-FD anchoring; configured
bridges on unsupported native hosts fail closed instead of using path-only checks.

Sent upload metadata is tracked separately from native output artifacts. The
authenticated `/api/chats/:chatId/shared-files` read returns up to 100 chat-scoped
upload references, not binary download URLs. Submission tracking persists this
metadata atomically with queue changes so completion and backend restarts do not
erase the files list. Local unsent and uncertain inputs are not represented as
confirmed shares. This metadata does not retain expired bytes or increase upload
quotas. Legacy recovery requires exact successful mutation records, owned upload
references and authoritative receipts; ambiguous associations are excluded.

The three-service Compose topology publishes only Caddy. An internal web network
connects frontend/backend; a separate Gateway network permits provider egress.
Backend data, Gateway state, bootstrap public material and Caddy state use separate
volumes. The test override installs a container-local deterministic provider and
blanks external provider keys; it is absent from normal deployment. Actual-Gateway
tests verify protocol/authentication/streaming/tools and controlled faults; an
explicit opt-in live-provider smoke is a separate verification boundary.
