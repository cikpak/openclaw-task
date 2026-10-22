import production from '../src/local-backend.js';
import type { BackendEnv } from '../src/auth/types.js';
export default {
  async fetch(request: Request, env: BackendEnv): Promise<Response> {
    if (
      new URL(request.url).pathname === '/__acceptance/expire-sessions' &&
      request.method === 'POST'
    ) {
      await env.AUTH_DB.prepare('UPDATE auth_sessions SET expires_at = ?')
        .bind(Date.now() - 1)
        .run();
      return Response.json({ ok: true });
    }
    return production.fetch(request, env);
  },
} satisfies ExportedHandler<BackendEnv>;
