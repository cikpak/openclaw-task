import type { ManagerEnv } from './types.js';
export { ConversationManager } from './durable-object.js';
export type { ManagerEnv } from './types.js';

export default {
  async fetch(request: Request, env: ManagerEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (
      path !== '/ws/conversation' &&
      path !== '/internal/revoke' &&
      !path.startsWith('/internal/files/')
    )
      return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    const id = env.MANAGERS.idFromName(env.MANAGER_ID ?? 'primary');
    return env.MANAGERS.get(id).fetch(request);
  },
} satisfies ExportedHandler<ManagerEnv>;
