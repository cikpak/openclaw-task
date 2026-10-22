import type { ManagerEnv } from './types.js';
import type { Grant, SocketAdmission } from './types.js';
import type { ManagerAuthorization } from './authorization.js';
import type { ManagerEvents } from './events.js';
import { type SocketAuthorization, renewalTime } from './socket-auth.js';
import type { ManagerFiles } from '../files/service.js';

/** Public admission and delivery stay separate from application command execution. */
export class ManagerHttp {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: ManagerEnv,
    private readonly authorization: ManagerAuthorization,
    private readonly sockets: SocketAuthorization,
    private readonly events: ManagerEvents,
    private readonly files: ManagerFiles,
  ) {}
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/internal/revoke' && request.method === 'POST') {
      let input: unknown;
      try {
        input = await request.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      if (
        !input ||
        typeof input !== 'object' ||
        !('sessionId' in input) ||
        typeof input.sessionId !== 'string'
      )
        return new Response(null, { status: 400 });
      this.authorization.revoke(input.sessionId);
      for (const socket of this.ctx.getWebSockets())
        if (this.sockets.admission(socket)?.grant.sessionId === input.sessionId)
          this.sockets.close(socket);
      await this.sockets.sync();
      return new Response(null, { status: 204 });
    }
    if (/^\/downloads\/[^/]+$/.test(path)) {
      try {
        return await this.files.download(request);
      } catch {
        return Response.json(
          {
            code: 'FILE_UNAVAILABLE',
            detail: 'This file is currently unavailable.',
          },
          { status: 503, headers: { 'cache-control': 'no-store' } },
        );
      }
    }
    if (path !== '/ws/conversation') return new Response(null, { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response(null, { status: 426 });
    const origin = request.headers.get('Origin');
    if (origin !== this.env.APP_ORIGIN)
      return new Response(null, { status: 403 });
    let grant: Grant;
    try {
      grant = await this.sockets.consume(request);
    } catch {
      return new Response(null, { status: 401 });
    }
    // A notification arriving while backend consumption was pending wins admission.
    if (this.authorization.revoked(grant.sessionId))
      return new Response(null, { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server!.serializeAttachment({
      grant,
      renewAt: renewalTime(grant),
    } satisfies SocketAdmission);
    this.ctx.acceptWebSocket(server!);
    await this.sockets.sync();
    this.events.connection(server!);
    return new Response(null, { status: 101, webSocket: client! });
  }
}
