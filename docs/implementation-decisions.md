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
