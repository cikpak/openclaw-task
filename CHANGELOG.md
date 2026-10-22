# Changelog

## Unreleased

### Cloudflare issue repairs

- Enlarge generated-file cards and download icons, align name and size in one
  row, and truncate long filenames without changing the original download name.
- Resolve published file references with native line/column citations and render
  code and prose references as authenticated downloads, keeping private paths hidden.
- Include durable file-sharing guidance with each native message so existing and
  new agents save deliverables in `documents/`. Keep preparation before the Stop
  fence and hide the exact private context from public history.
- Activate the supported direct Codex tool-loading configuration before dispatch,
  preserving the model, tool permissions and unrelated restored configuration.
- Retain exact native Stop acknowledgements across delayed history visibility and
  separately prove cancellation before execution. Scope receipts and history reads
  to the original request so replacement messages cannot inherit stale authority.
- Reject closed or failed verification-socket writes immediately without replaying
  mutations or waiting for an unrelated command timeout.
- Make the isolated restart fault control validate the exact Gateway process and
  await native child cleanup within its existing deadline before ordinary restart.
- Let exact test-container cleanup settle classified concurrent Docker removals
  within a bounded interval, retaining final absence, closed-port and unrelated
  container checks and publishing safe failure evidence in CI.

### Cloudflare migration

- Keep Pages frontend, Backend/D1 authentication and SQLite manager available
  independently of the sleeping OpenClaw container. Application data uses an
  authorized manager socket; admission and exact-session downloads stay HTTP.
- Add durable wake/idle preservation, option-B cancellation until final stop,
  helper-only restored boots, private native SDK identity and direct R2 recovery.
- Stage uploads without wake; protect live/asleep downloads with one-minute
  single-use permissions, explicit publication and independent reader pins.
- Cache whole safe messages by measured viewport and recover complete long native
  replies without turning display limits into retention policy.
- Replace active Compose/Caddy/DigitalOcean deployment with an isolated Cloudflare
  workflow and manual local deployment; CI checks only. Preserve old evidence as
  historical and update the separate OpenClaw documentation project.
- Verify the real GPT-5 production cycle: file creation, automatic save/stop,
  exact-session download without waking, fresh restore, original conversation
  memory and native file reading. Keep these results separate from provider-free
  tests; the original invalid key is not shipped.

### Latest settings and interaction updates

- Added custom instructions, response style and personality to application
  defaults and per-chat Agent Settings. New agents copy defaults once; changing
  them later does not overwrite existing chats or unrelated native instructions.
- Disabled settings saves when nothing changed and made save notifications
  dismiss after three seconds, pausing dismissal while keyboard-focused.
- Reduced outline icons to 16px while keeping mobile touch targets, restored
  visible sign-out/deletion icons, and tightened confirmation-button sizing.
- Split login into two centered columns with a textured gradient panel, removed
  the workspace slogans, and improved sidebar/settings hover feedback.
- Added working/finished/failed chat indicators, a centered blue chat glow with
  an opaque header, and stronger message-background contrast.
- Made tool calls animated inline chips with tool-specific icons and details
  available after 200ms hover, keyboard focus or click; results remain in the
  popover rather than filling the transcript.
- Aligned the transcript/composer, history-loading control and returned file
  labels; moved attachment previews upward and unified upload hover/focus styles.
- Excluded OpenClaw's inbound upload staging from generated-file listings so a
  sent image is not also presented as an agent-created file.
- Fixed the steering/abort browser fixture to confirm delivery, then start an
  explicitly active delayed turn before testing Stop. Kept delivery/isolation
  assertions and existing timeouts intact.
- Updated assessment coverage and dated local verification records, including
  the distinction between Compose health waiting and application readiness.

### Interaction polish

- Lifted select options into the browser top layer with viewport-aware positioning,
  visible scroll-container borders, and native modal keyboard/focus handling.
- Added scoped, read-only generated-document catalogs and authenticated downloads;
  local Markdown file links no longer open the app as a filesystem route.
- Replaced duplicate generic tool output messages with named chronological tool
  cards and readable parameters, document previews, and results.
- Rendered agent replies as styled Markdown, including headings, lists, emphasis,
  links, code and tables, while keeping user messages literal and streaming live.
- Blocked raw HTML and unsafe Markdown URLs; remote images remain manual links.
- Adopted Heroicons' 24px outline set while retaining the black brand mark.
- Made submitted inputs ordinary user bubbles, added a one-time reply entrance
  with reduced-motion support, and widened the desktop transcript by 20%.
- Preferred Medium thinking for new model selections when offered, without
  resetting saved choices or inventing unsupported capabilities.
- Separated sent uploads (Shared with agent) from downloadable native outputs
  (From agent), preserving bounded sent-file metadata after queue completion.
- Kept thinking/live replies last, below submitted inputs and tool activity,
  without remounting replies or pulling readers away from older content.
- Removed message, queued-card, and tool-container outlines while retaining fills.
- Moved conversation files into an animated, collapsible left-side tab with
  in-panel loading feedback, cached refreshes, and isolated/cancelled reads.
- Collapsed canonical tool results, decoded recognized text envelopes for reading,
  and removed empty tool-call-only assistant bubbles without discarding deliveries.
- Added action-specific spinners, consistent 24px outline controls, accessible
  Floating UI selects, and animated native-dialog exits with reduced-motion support.
- Retained bounded terminal previews while canonical history catches up, preserved
  native message ordering, and distinguished unknown from unsupported Fast capability.
- Stabilized the chat shell and composer, added 85% message bubbles and thinking
  shimmer, and preserved reader position through streaming and history paging.
- Added a local black favicon, per-page titles, and a transport-aware colored
  Gateway connection indicator.
- Added isolated desktop/mobile checks for control alignment, select/dialog focus,
  actual incremental text paints, bounded bubbles, and reader-controlled scrolling.
- Kept notifications clear of header actions and made rapid keyboard selection
  reliable before the next animation frame, including reduced-motion interactions.

### Monochrome interface

- Replaced the green/serif presentation with self-hosted Inter, white content,
  a flat gray sidebar, a black logo, compact controls, and understated dividers.
- Tightened headings, navigation, dialogs, settings, and the composer while
  retaining readable message text, keyboard focus, and mobile touch targets.
- Fixed sibling React key collisions that duplicated the composer when agent
  settings closed; added draft-preservation and desktop/mobile style checks.
- Made whole-suite test cleanup verify already-completed deletions and respect
  the real login rate-limit cooldown without weakening production safeguards.

### Phase 1: foundation

- Started the React/TypeScript and Fastify/SQLite workspace with shared contracts.
- Pinned OpenClaw Gateway client and protocol to 2026.10.1.
- Added private service networks, persistent data volumes, and a Caddy frontend.
- Added authenticated device bootstrap with public-only identity exchange.

### Phase 2: durable conversation coordination

- Added independent chat lifecycle, ten transactional capacity reservations, and
  durable per-chat dispatch with twenty pending messages and stable edit positions.
- Added queued cancel/steer, abort, deferred settings, preferences, and explicit
  recovery for uncertain submissions and settings.
- Reconciled receipts, creation/deletion tombstones, and stale read/event races;
  accepted queues continue when browsers disconnect.
- Added own-agent automatic titles with manual rename precedence and bounded
  device-pairing/config-reload recovery verified against the real pinned Gateway.

### Phase 3: responsive messenger

- Added authenticated desktop/mobile routes, independent drafts, two-step chat
  creation, queue correction/recovery controls, and coordinated settings.
- Added shared capability-aware model controls, bounded streamed projections,
  canonical history paging, safe reconnect replay, and conflict refresh actions.
- Added component/store regression tests for stale snapshots, correction races,
  retained history, route deletion, and append/replacement recovery.

### Phase 4: tools and media

- Added signature-checked opaque uploads with admission/deletion fencing and
  retention for accepted messages across expiry and recovery.
- Added bounded allowed-tool activity, canonical recovery reconciliation, and
  chat-scoped native artifact catalogs and downloads without URL fetching.
- Verified actual text, Markdown, PDF and PNG consumption, tool reconnect state,
  native PNG download byte equality, and wrong-chat rejection against OpenClaw.

### Integration fixes

- Kept final canonical history visible when read flags, renames, or generated
  titles change during refresh, while retaining execution-race protection and
  coalesced retry for superseded authoritative reads.
- Coordinated agent configuration mutations through confirmed session startup
  and deletion so concurrent chat creation cannot supersede Gateway reloads;
  ordinary conversation execution remains concurrent.
- Bounded live previews and reconnect projections without discarding durable
  accepted inputs; released deleted-chat caches and bounded tool watermarks.
- Separated Caddy client login limits, kept direct development untrusted, and
  removed persistent copies of read-only snapshot/history results.
- Added outbound event/media validation, safe internal-error classification,
  browser/server import boundaries, and scoped offline attachment capabilities
  with fresh compatibility checks before dispatch.
- Preserved visible keyboard focus and reduced motion, increased reading text,
  and made mobile controls accessible without blocking header actions.
- Paired agent names, settings and versions from the same response so a
  settings-only save cannot overwrite a concurrent rename; conflicts retain
  edits and require explicit refresh and confirmation.
- Followed streaming content only while readers stay near the conversation
  bottom, including equal-length replacements, and enlarged recovery guidance.
- Fenced history against exact known-terminal run IDs so transient upstream
  controller cleanup cannot restore completed work or block the next queued input.

### Phase 5: delivery and acceptance

- Added isolated fresh Compose acceptance against the actual pinned Gateway,
  deterministic provider, desktop/mobile journeys, media, restarts, session
  expiry, all-browser closure, and ten overlapping independent agents.
- Added resource/backpressure regression tests, strict quality and integration
  CI jobs, optional credential-controlled live-provider smoke, and Conductor
  setup/run/check commands.
- Documented the approved specification, architecture, reproducible testing,
  acceptance boundaries, retained recovery receipts, and provider limitations.

## Initial repository

- Added local gstack tooling before application implementation.
