# OpenClaw Messenger

A single-user messenger with independent OpenClaw agents. The backend owns durable
unsent queues; OpenClaw owns submitted execution and canonical transcripts.

## Setup

Prerequisites: Docker Engine/Desktop with Compose 2.24.4 or newer, Node.js 24,
and pnpm 10.29.3. OpenClaw and its Gateway packages are pinned to `2026.10.1`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm setup:env
```

The generator asks for an app password and creates a private `.env`. Add an
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and choose an available `DEFAULT_MODEL`.
The default username is `admin`. Keep provider keys, `SESSION_KEY`, and
`GATEWAY_TOKEN` private. The frontend receives none of these secrets.

```sh
docker compose up --build
```

Open `http://localhost:8080`. Only Caddy publishes application ports. Initial device pairing
can take a few minutes; the frontend remains available while the Gateway starts.
`/health` reports backend liveness and `/ready` reports dependency readiness.

For detached startup with container health waiting:

```sh
docker compose up --build -d --wait --wait-timeout 300
```

The backend healthcheck uses `/health`, and the frontend has no container
healthcheck. `--wait` therefore does not guarantee authenticated Gateway readiness;
check `http://localhost:8080/ready` before testing chat execution.

## DigitalOcean App Platform demo

For a disposable demo, `.do/app.yaml` runs Caddy, the backend, and OpenClaw
`2026.9.33` (the official extended-stable release) together in one container.
This deployment uses that release because `2026.10.1` rejects App Platform's
synthetic PID-namespace inodes during Gateway startup.
**All data is temporary:** a deployment or container
replacement can reset chats, uploads, agent settings, and device identities.
There are no backups or additional storage/database services.

1. Push the deployment files to `cikpak/openclaw-task` on `master` and authorize
   DigitalOcean to read that GitHub repository.
2. Create one App Platform **Web Service** from the repository root using
   `deploy/app-platform.Dockerfile`. Leave build/run command overrides empty.
   Use public HTTP port `8080`, route `/`, one instance, and disable autodeploy.
   The spec defaults to Frankfurt and `apps-s-2vcpu-4gb` (4 GiB RAM, 2 shared CPUs);
   choose another region or size in DigitalOcean if needed.
3. Under **Settings → messenger → Environment Variables**, add the following
   **Run Time** variables. Select **Encrypt** for every secret; copy values from
   your private `.env` without surrounding shell quotes. Component variables
   override app-level variables, so configure these in `messenger` rather than
   duplicating them at app level. Never commit `.env` or plaintext secrets.

   | Variable                                            | Value                                           |
   | --------------------------------------------------- | ----------------------------------------------- |
   | `APP_ORIGIN`                                        | `${APP_URL}` (DigitalOcean bindable variable)   |
   | `APP_USERNAME`                                      | Your login username, default `admin`            |
   | `DEFAULT_MODEL`                                     | A model available with your chosen provider key |
   | `ALLOW_INSECURE_LOOPBACK`                           | `false`                                         |
   | `APP_PASSWORD_HASH`, `SESSION_KEY`, `GATEWAY_TOKEN` | Current `.env` values; encrypted                |
   | `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`         | Your provider key; encrypted                    |

4. Set the HTTP health check to `/ready` on `8080`, initial delay 60 seconds,
   interval 10 seconds, timeout 5 seconds, success threshold 1, failure threshold 30.
   DigitalOcean supplies public HTTPS; the startup script configures internal
   ports, local Gateway TLS, automatic device pairing, and temporary paths.
5. Deploy, then manually check `/ready`, login, a streamed reply, and file
   upload/download through the generated HTTPS URL. Delete the app after the demo.

For CLI creation, use `doctl apps create --spec .do/app.yaml` after authenticating
with `doctl auth init`. The committed spec intentionally omits credentials,
username, and model: its first deployment cannot become ready until you set
the runtime values under `messenger` in the control panel and redeploy.
Repository pushes do not apply YAML
settings automatically; edit the app settings or submit an updated app spec.
For updates, export and edit the current app spec so configured runtime values
are preserved; do not replace a configured app with this creation template.

## Development and checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm format:check
```

Backend tests use real SQLite with a controllable Gateway; frontend tests exercise
stores and components. Run the actual pinned Gateway, desktop/mobile journeys,
restart faults, and ten concurrent agents against a local deterministic provider:

```sh
pnpm exec playwright install chromium
pnpm test:acceptance
```

The acceptance command provisions a fresh synthetic Compose project, generates
private test credentials, pairs automatically, and normally removes that project's
disposable volumes. It requires no external model key. Set `ACCEPTANCE_PORT` if
18080 is occupied. [Testing](docs/testing.md) documents reports, resource samples,
failure diagnosis, and the explicitly enabled live-provider smoke. The
[acceptance record](docs/implementation-status.md) and actual branch CI results
distinguish observed passes from checks still pending.

## Configuration and operations

- `.env.example` documents environment variables. Sessions last 24 hours.
- Loopback HTTP requires `ALLOW_INSECURE_LOOPBACK=true`; HTTPS uses secure cookies.
- Backend SQLite data and OpenClaw state use separate persistent Docker volumes.
- Restarting containers preserves accepted queues and device identity.
- Startup generates `openclaw.json` only if it does not exist. Changing
  `DEFAULT_MODEL` in `.env` does not rewrite saved native defaults. Choose an
  available model in application/Agent Settings for new or existing chats;
  recreate containers to apply changed provider environment variables.
- `docker compose down` stops services while retaining volumes. Removing volumes
  destroys chat state; back up both data volumes before doing so.
- A missing provider key permits startup and authentication, but model execution
  cannot succeed. A missing Gateway token or app session secret fails configuration.
- Direct development trusts no forwarded client address; Compose trusts exactly
  its one Caddy proxy hop for login throttling.

For an HTTPS host, point DNS at the server and configure `APP_SITE=your.domain`,
`APP_ORIGIN=https://your.domain`, `APP_BIND_ADDRESS=0.0.0.0`, `APP_PORT=80`,
`APP_HTTPS_PORT=443`, and `ALLOW_INSECURE_LOOPBACK=false`. Caddy obtains and retains
TLS certificates through its own egress network; backend and Gateway ports remain
private. The default binding is loopback only, with HTTP on 8080 and HTTPS on 8443.

## Design and limits

Up to ten visible chats, twenty editable pending messages per chat, and paged history.
Queued edits retain their position. Unknown submission outcomes remain visible
and must be reconciled before any replay. Browser closure does not stop accepted
work. Filesystem tools are workspace-only; arbitrary commands and cross-agent
tools are disabled. Separate workspaces are not a hard filesystem sandbox.

Already-uploaded attachments can be queued during a Gateway outage when the
backend has verified capabilities for that exact chat agent, session, and model.
Dispatch checks fresh capabilities before sending bytes. After a backend restart,
a missing capability cache produces an actionable error while keeping the draft
and uploaded files. Accepted queue/recovery attachments remain retained.

The conversation's left-side files tab separates **Shared with agent** (files
you sent) from **From agent** (native outputs and generated workspace documents). Sent-file entries
are metadata, not permanent downloads: temporary upload expiry is unchanged.
The catalog keeps the latest 100 sent upload references per chat. Older sends
can be recovered only when retained records and exact Gateway receipts establish
their association; ambiguous historical files are not guessed into a chat.

New model selections prefer Medium thinking when the model advertises it.
Saved thinking choices and existing agent settings remain unchanged; models
without Medium use their supported default.

Application settings offer custom instructions (up to 8,000 characters), response
style (Default, Concise, Detailed), and personality (Neutral, Friendly,
Professional, Direct). New agents copy these defaults once; later global changes
do not modify existing agents. Agent Settings controls the selected conversation
independently, using the existing wait-until-idle or cancel-work-and-apply choice.
Changes affect future runs, not previous messages.

These options add ordinary guidance to an app-managed section of the selected
agent's native instruction file; they do not grant tool permissions or guarantee
model compliance. Default/Neutral add no extra preset guidance. Clearing custom
instructions and resetting both presets removes that section while preserving
unrelated file content. Conflicts or uncertain application remain in recovery
rather than silently overwriting native changes.

Agent replies render Markdown headings, lists, emphasis, links, code and tables
as they stream. User messages remain literal text. Raw HTML is not executed,
unsafe URLs are blocked, and remote images are links rather than automatic loads.
Local document links resolve through authenticated, chat-scoped downloads instead
of navigating to internal filesystem paths. Generated files up to 5 MiB are
listed through a read-only workspace mount; hidden files, bootstrap instructions,
credentials, upload storage, symlinks, and cross-agent paths are excluded.
Tool calls appear as compact inline chips with tool-specific icons. Hover for
200 milliseconds, focus, or click to open a positioned details popover with
parameters, document content, results, and downloads. Raw tool output stays out
of the chat, without duplicate output messages.

The assessment's Device Authentication, Tool Call Display, and Image Attachments
bonuses are implemented within these limits. Config Generator is partial: startup
generates native configuration and agent lifecycle changes use Gateway RPCs, but
there is no general configuration-generation/editing API or UI. See the
[assessment coverage](docs/acceptance.md) for the full requirement mapping.

Deleting a conversation cancels its selected active/queued work, confirms agent
deletion, and removes its Gateway workspace. Mutation idempotency/recovery receipts
and deletion tombstones remain to prevent stale retries from replaying work; this
is not complete backend-data erasure. Snapshot/history reads are not persisted as
command receipts. Native transferable image artifacts are downloadable. Unsupported
preview entries are excluded from the catalog; URL-only metadata may be listed,
but downloads return `422` without fetching the URL. These limits and the separate live-provider
verification boundary are recorded in [acceptance coverage](docs/acceptance.md).

See [architecture](docs/architecture.md), [verified OpenClaw sources](docs/openclaw-research.md),
and the [changelog](CHANGELOG.md).
The approved implementation plan at `docs/plans/approved-openclaw-messenger.md` is
preserved locally as a historical specification and is not included in Git. Current
results are in the acceptance record; the linked architecture is included in the repository.

## Troubleshooting

- During initial pairing, `/health` can succeed while `/ready` is unavailable.
  Allow initialization to finish; verify the documented Gateway token, persistent
  volumes, and pinned image rather than approving an arbitrary device manually.
- A connected Gateway without an available model needs a valid provider key and
  configured `DEFAULT_MODEL`. Keep keys in the private environment file.
- For unconfirmed delivery, inspect canonical history before using explicit
  receipt-checked recovery. Do not resend just because a connection ended.
- For a version conflict, use “Refresh latest values and models, keep my edits”
  and review before confirming again. Mutations wait for the initial settings read.
- If offline attachment capabilities are unavailable after a backend restart,
  wait for Gateway reconnection and retry with the retained draft/upload. Accepted
  recovery references remain retained; unused upload lifetime is bounded.

## AI assistance

Codex implemented this application with focused implementation and review agents.
Generated work is verified with type checks, application tests, and integration
checks. The acceptance record distinguishes completed checks from unavailable
provider tests; it does not claim passing checks that were not run.
