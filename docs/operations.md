# Local development and manual deployment

## Tooling and private configuration

Use Node.js 24, pnpm 10.29.3 and running Docker Engine/Desktop. Docker runs only
the pinned OpenClaw/helper image. Workers use cf 1.0.0-beta.19, Vite 8.3.4 and
Cloudflare Vite plugin 2.0.0-beta.v.3. Wrangler 4.136.0 is for Pages commands only;
use cf for other Cloudflare operations. Compose, Caddy and DigitalOcean deployment
files/commands are retired; old instructions are explicitly historical.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm setup:env
pnpm dev
```

The setup command privately prompts for an application password of at least
12 characters and writes a mode 0600 `.env` with its salted password hash, username, selected default model
and optional provider keys. Add a valid `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and
select an available `DEFAULT_MODEL` for real execution. The manager generates its
Gateway/helper tokens and signing identity; users do not configure `SESSION_KEY`
or `GATEWAY_TOKEN`. Keep private environment/secret JSON files out of Git and build
contexts. Missing provider credentials allow app authentication/cached use but
cannot produce a real agent reply. Never ship a known-invalid provider key.

## One Cloudflare harness, separate frontend Vite

`pnpm dev` starts one Cloudflare harness containing both Workers and a Pages-
equivalent thin facade, plus a separate frontend Vite server with same-origin
HTTP/WebSocket proxying. The runner prints its actual frontend address. Local-only
Worker/DO/container names, ports and state are derived from workspace identity;
production resource names remain fixed. Ordinary development uses the `development`
mode (`local` is reserved by Vite). Native local Explorer/observability APIs are
disabled; ordinary application HTTP/WebSocket access is loopback-only. Docker can
reach only the exact signed local S3 surface, not application/control APIs.
Runtime information is stored under
`.context/cloudflare-local/<workspace-id>/runtime.json`.

Optional environment overrides are `FRONTEND_PORT`, `CLOUDFLARE_PORT`,
`CLOUDFLARE_STATE_DIR` and `MESSENGER_ENV_FILE`. Use workspace-private state and
avoid reusing another workspace's ports or container namespace. Stop the runner
to stop its processes; preserve its local state unless deliberately resetting
that isolated development instance. Do not clean unrelated Docker resources.

Recovery transfers use the supported local R2 S3 emulator, with local-only signing
credentials and an exact expiring method/key grant. The helper reaches that
workspace emulator directly; archive bytes still bypass the DO. No cloud S3
credentials or production-bucket writes are needed for local development. Local
origin/base-path allowances are guarded from production deployment. This path must
be exercised by the local save/stop/restore acceptance check, not inferred from
metadata-only R2 tests. See [testing](testing.md) and [release evidence](release-verification.md).

## Production resources and authorization

The approved production topology uses private R2 `openclaw-messenger-production`,
D1 `openclaw-messenger-auth`, Backend and Manager Workers, one SQLite DO/container
application and Direct Upload Pages project `openclaw-messenger`. The intended
origin is `https://openclaw-messenger.pages.dev`; a named origin alone is not proof
of deployment. Start with fresh application data. Retained experiment resources
and the original workspace branch remain untouched.

Deployment runs **manually from the authorized Mac using cf OAuth**. The user
explicitly rejected GitHub Actions deployment; Actions runs CI checks only, with
no automatic deploy or `workflow_dispatch` deploy. The user also explicitly
authorized reuse of supplied experiment R2 credentials for the new private
production bucket. Keep those credentials private; helper receives only narrow
object grants. No API-token creation permission is required to reuse the existing
local deployment login.

## Build immutable artifacts from one commit

Finish checks, independent review and commit first. Build from a clean committed
target checkout. Do not modify source while assembling a release. Prepare private
JSON files without printing their contents:

| Input                          | Shape / purpose                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `RELEASE_RUNTIME_FILE`         | `{ "appOrigin": "https://…", "username": "…", "defaultModel": "provider/model" }`; nonsecret build/runtime values |
| `RELEASE_BACKEND_SECRETS_FILE` | JSON with `APP_PASSWORD_HASH`                                                                                     |
| `RELEASE_MANAGER_SECRETS_FILE` | JSON with `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and only actually supplied optional provider secrets         |

The selected manager bundle determines configured provider binding names; ambient
`.env` values/test keys must not silently add a provider. Absent optional providers
are omitted, not filled with invalid or empty secrets. Frontend build receives no
server secrets.

```sh
RELEASE_RUNTIME_FILE=/private/runtime.json \
RELEASE_MANAGER_SECRETS_FILE=/private/manager-secrets.json \
  pnpm release:build /absolute/path/to/new-release-artifacts
```

The artifact directory contains the commit/source identity, immutable compiled
Worker/Pages outputs, container image archive/identity, tracked container-source
archive, same-commit D1 `migrations/` and integrity manifest. Pages Functions compile
to the advanced-mode directory `pages/_worker.js/index.js`; multipart `--outfile`
bytes are not a deployable Worker bundle.
Retain this one bundle for every step and repeat deployment; do not rebuild
between bootstrap, manager, backend and Pages. Secrets are separate private input
files, not copied into release artifacts.

## First deployment order

Provision resources and apply D1 migrations through cf before enabling login. Use
explicit artifact directory and mode on every invocation:

```sh
RELEASE_BACKEND_SECRETS_FILE=/private/backend-secrets.json \
  pnpm release:deploy /absolute/path/to/release-artifacts backend-bootstrap
RELEASE_MANAGER_SECRETS_FILE=/private/manager-secrets.json \
  pnpm release:deploy /absolute/path/to/release-artifacts manager --initial-container
RELEASE_BACKEND_SECRETS_FILE=/private/backend-secrets.json \
  pnpm release:deploy /absolute/path/to/release-artifacts backend
pnpm release:deploy /absolute/path/to/release-artifacts pages
```

Bootstrap Backend omits the reverse Manager binding and keeps public login/tickets
closed. Manager then binds Backend; full Backend binds Manager. Pages deploys last
with explicit service bindings, compatible date and dynamic `fail_open=false`.
Static assets bypass Functions; exact `/api` and unknown nested API routes return
API errors rather than SPA HTML. Worker `workers.dev` and preview URLs remain
disabled. Inspect actual deployed bindings/settings, not only local config.
The manager-only `--initial-container` option uploads/provisions the first engine
image with immediate rollout. Use it only before an engine exists; omit it on
subsequent deployments to preserve active engines.

Subsequent releases update compatible Workers before Pages from the same immutable
bundle. Container rollout is explicitly **`--containers-rollout none`**: code
deployments must not replace active engines. Managers reconnect to existing native
state and reconcile durable operations; new images apply on a later clean wake.
If cf partially applies a Worker then fails a container step, inspect actual
resources before retrying or making a narrowly scoped repair. Do not infer failure
from CLI timeout alone.

Verify public-origin login/cookie, exact-session fresh tickets/replay denial,
logout/revocation, ownership, deep links, static routing, unknown API errors,
private entry points, secret-free frontend and sanitized sentinel logs. Check
fresh/repeat deployment and an active-engine manager restart. With valid provider
credentials, run the complete release loop in [release verification](release-verification.md).
Rolling back app code must never roll engine state back to an older generation.

## Logs, recovery and diagnosis

Use sanitized route/status/correlation logs only. Disable invocation URL capture
and traces; do not attach a retained raw request sink. Pages real-time tail
envelopes contain raw URL/headers: never tail production ticket/download traffic
with real secrets. Public errors contain no native paths, stack or raw payload.

If native startup fails, distinguish helper-running, restored, Gateway-running and
SDK-authenticated-ready. Preserve queue/receipts and inspect controlled outcomes.
A failed save keeps current disk and prior checkpoint; a failed restore keeps
Gateway stopped. Never clear lifecycle/recovery records or initialize empty state
to make readiness pass. Uncertain native submission requires receipt/history
reconciliation, not unconditional resend. Missing valid provider credentials are
an explicit execution blocker, not evidence of a broken cached frontend.
