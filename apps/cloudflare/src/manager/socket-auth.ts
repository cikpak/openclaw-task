import { AuthenticationError } from '../../../backend/src/errors.js';
import type { ManagerAuthorization } from './authorization.js';
import type { Grant, SocketAdmission, DeadlineScheduler } from './types.js';

export const renewalTime = (grant: Grant): number =>
  Math.min(
    grant.expiresAt,
    Date.now() +
      Math.max(
        1000,
        Math.min(5 * 60 * 1000, (grant.expiresAt - Date.now()) / 2),
      ),
  );
export class SocketAuthorization {
  constructor(
    private readonly state: DurableObjectState,
    private readonly authorization: ManagerAuthorization,
    private readonly schedule: DeadlineScheduler,
  ) {}
  admission(socket: WebSocket): SocketAdmission | null {
    try {
      return socket.deserializeAttachment() as SocketAdmission | null;
    } catch {
      return null;
    }
  }
  close(socket: WebSocket): void {
    try {
      socket.serializeAttachment(null);
      socket.close(4001, 'Sign in to continue.');
    } catch {
      /* Already closed. */
    }
  }
  live(socket: WebSocket): Grant | null {
    const grant = this.admission(socket)?.grant;
    if (
      !grant ||
      grant.expiresAt <= Date.now() ||
      this.authorization.revoked(grant.sessionId)
    ) {
      this.close(socket);
      return null;
    }
    return grant;
  }
  async consume(request: Request): Promise<Grant> {
    const url = new URL(request.url);
    const tickets = url.searchParams.getAll('ticket');
    const cookies = (request.headers.get('Cookie') ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('__Host-messenger_session='));
    const sessionToken = cookies[0]?.slice('__Host-messenger_session='.length);
    const origin = request.headers.get('Origin');
    if (
      tickets.length !== 1 ||
      !tickets[0] ||
      tickets[0].length > 1024 ||
      cookies.length !== 1 ||
      !sessionToken ||
      !origin
    )
      throw new AuthenticationError();
    return this.authorization.grant('consume', {
      ticket: tickets[0],
      sessionToken,
      origin,
    });
  }
  async renew(): Promise<void> {
    for (const socket of this.state.getWebSockets()) {
      const admission = this.admission(socket);
      if (!admission || !this.live(socket) || admission.renewAt > Date.now())
        continue;
      try {
        const grant = await this.authorization.grant('renew', {
          grantId: admission.grant.id,
        });
        if (
          grant.sessionId !== admission.grant.sessionId ||
          grant.accountId !== admission.grant.accountId
        )
          throw new AuthenticationError();
        socket.serializeAttachment({
          grant,
          renewAt: renewalTime(grant),
        } satisfies SocketAdmission);
      } catch {
        this.close(socket);
      }
    }
    await this.sync();
  }
  async sync(): Promise<void> {
    const deadlines = this.state
      .getWebSockets()
      .map((socket) => this.admission(socket))
      .filter((value): value is SocketAdmission => !!value)
      .map(({ grant, renewAt }) => Math.min(grant.expiresAt, renewAt));
    await this.schedule.set(
      'auth',
      deadlines.length ? Math.min(...deadlines) : null,
    );
  }
}
