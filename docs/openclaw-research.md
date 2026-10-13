# OpenClaw compatibility research

Pinned runtime, Gateway client, and Gateway protocol: **2026.10.1**.

Primary sources inspected during implementation:

- [Published Gateway client](https://registry.npmjs.org/@openclaw/gateway-client/2026.10.1)
- [Gateway TLS implementation](https://github.com/openclaw/openclaw/blob/v2026.10.1/src/infra/tls/gateway.ts)
- [Device CLI implementation](https://github.com/openclaw/openclaw/blob/v2026.10.1/src/cli/devices-cli.runtime.ts)
- [Tool policy schema](https://github.com/openclaw/openclaw/blob/v2026.10.1/src/config/zod-schema.agent-runtime.ts)
- [Official container definition](https://github.com/openclaw/openclaw/blob/v2026.10.1/Dockerfile)
- [Chat submission and recovery schema](https://github.com/openclaw/openclaw/blob/v2026.10.1/packages/gateway-protocol/src/schema/logs-chat.ts)
- [Submitted queue edit eligibility](https://github.com/openclaw/openclaw/blob/v2026.10.1/ui/src/lib/chat/chat-queue-order.ts)

The official Node client accepts a persisted Ed25519 device identity, scoped
operator authentication, `tool-events`, and a normalized SHA-256 TLS fingerprint.
Its default reconnect loop does not supply application-level delivery semantics;
durable intent and receipt reconciliation live in the backend.

The device CLI supports explicit request IDs and local approval fallback. This
application uses the explicit form only after matching device ID, raw public key,
operator role, and exact required scopes. Certificate auto-generation requires
OpenSSL inside the official image; private keys remain in the OpenClaw volume.

Further RPC assumptions are verified against the installed official protocol
schemas and real Gateway tests rather than relying on method-name guesses.
