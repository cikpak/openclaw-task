# OpenClaw Messenger

A single-user React messenger whose frontend remains available while OpenClaw
sleeps. Cloudflare Pages serves the UI; private Workers, D1, a SQLite Durable Object
and R2 keep authentication, accepted queues, recent safe history and saved files
available independently of the engine. Sending work wakes the attached container.

OpenClaw and its official Gateway SDK are pinned to **2026.10.1**. One manager and
one standard-2 container are used in this prototype. Native execution remains the
authority for submitted work; durable receipts reconcile uncertain delivery.

## Start and verify

Use Node.js 24, pnpm 10.29.3 and a running Docker Engine/Desktop. Install workspace
dependencies with `pnpm install --frozen-lockfile`. Follow [local development and
manual deployment](docs/operations.md) for the isolated Cloudflare harness, private
configuration and release order. Docker runs only the OpenClaw/helper image.
Compose, Caddy and DigitalOcean deployment instructions are retired.

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

[Testing](docs/testing.md) separates application tests, actual Workers-runtime
checks, real pinned native SDK/helper recovery and provider-dependent release
verification. [Release evidence](docs/release-verification.md) records the manual
production deployment and actual GPT-5 file creation, download while the engine
is stopped, fresh restore and continuation of the same conversation. Cold startup
can take several minutes; accepted sends remain durable during that wait. Final
branch CI is available on [PR 1](https://github.com/cikpak/openclaw-task/pull/1).

## Behavior and limits

- Login, connecting, recent history and saved-file access do not wake OpenClaw.
  Send durably acknowledges before startup; accepted work continues after logout.
- Recent history contains whole messages sized to roughly two viewport screens.
  Explicit older uncached history can wake the engine; full native history is
  preserved independently of transport limits.
- Up to ten visible independent agents and twenty pending messages per chat.
  Revision checks, stable queue edits, model overrides, settings and uncertain
  delivery recovery remain supported.
- Attachments stage without waking: five/message, 5 MiB/file, 10 MiB/message;
  100 MiB/200-upload retention quota and one-hour unused expiry.
- Only explicitly classified eligible deliverables are published. Native paths,
  credentials, internal files and raw tool data stay private. Downloads use
  exact-session single-use application permissions valid for **60 seconds**.
- After 60 seconds of genuine inactivity, the engine preserves coherent logical
  state before stopping. New work cancels until final platform stop issuance.
  Failed saves keep current local state; failed restores keep accepted work and
  do not substitute an empty engine.

Model-provider keys, R2 credentials and native control identities remain private;
the frontend receives no server secrets. Application settings provide custom
instructions, response style and personality; per-agent changes retain existing
idle/cancel-work guards. Tool restrictions are not a hard OS sandbox. Markdown
replies render safely without raw HTML or automatic remote-image loads.

## Documentation

- [Architecture, authentication, credential roles and lifecycle](docs/architecture.md)
- [Local workflow and manual deployment](docs/operations.md)
- [Acceptance coverage](docs/acceptance.md) and [release verification](docs/release-verification.md)
- [Decisions, alternatives and tradeoffs](docs/decisions-and-tradeoffs.md)
- [Implementation decisions](docs/implementation-decisions.md), [historical results](docs/implementation-status.md)
  and [compatibility research](docs/openclaw-research.md)
- [Changelog](CHANGELOG.md)

The separate OpenClaw Obsidian project mirrors the current explanation while
preserving historical choices and failed experiments. AI-assisted implementation
uses focused implementation/review agents and explicit verification evidence;
passing mocks or provider-free native checks never imply a real model turn passed.
