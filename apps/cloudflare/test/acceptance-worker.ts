import './acceptance-timing.js';
/** Acceptance-only entrypoint: production modes never include this module. */
import { ConversationManager as ProductionManager } from '../src/manager/durable-object.js';
import production from '../src/manager/worker.js';
import { PrivateContainer } from '../src/engine/container.js';
import type { ManagerEnv } from '../src/manager/types.js';
import { restartGateway } from './acceptance-restart.js';
import { receiptProof } from './acceptance-receipt.js';
import { journalProof } from './acceptance-journal.js';
import { outcomeProof } from './acceptance-outcome.js';
import { healthObservations } from './acceptance-health.ts';
export class ConversationManager extends ProductionManager {
  private readonly construction: number;
  constructor(state: DurableObjectState, env: ManagerEnv) {
    super(state, env);
    state.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS acceptance_restarts (id INTEGER PRIMARY KEY, count INTEGER NOT NULL)',
    );
    state.storage.sql.exec(
      'INSERT INTO acceptance_restarts VALUES (1,1) ON CONFLICT(id) DO UPDATE SET count = count + 1',
    );
    this.construction = [
      ...state.storage.sql.exec<{ count: number }>(
        'SELECT count FROM acceptance_restarts WHERE id = 1',
      ),
    ][0]!.count;
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/__acceptance/')) return super.fetch(request);
    if (path === '/__acceptance/outcome-proof' && request.method === 'POST') {
      const engine = (
        this as unknown as {
          engine?: { gateway: Parameters<typeof outcomeProof>[1] };
        }
      ).engine;
      return Response.json(
        await outcomeProof(this.ctx, engine?.gateway, request),
      );
    }
    if (path === '/__acceptance/journal-proof' && request.method === 'POST') {
      const engine = (
        this as unknown as {
          engine?: { gateway: Parameters<typeof journalProof>[1] };
        }
      ).engine;
      return Response.json(
        await journalProof(this.ctx, engine?.gateway, request),
      );
    }
    if (path === '/__acceptance/receipt-proof') {
      const engine = (
        this as unknown as {
          engine?: { gateway: Parameters<typeof receiptProof>[1] };
        }
      ).engine;
      return Response.json(await receiptProof(this.ctx, engine?.gateway));
    }
    if (path === '/__acceptance/status') {
      const row = [
        ...this.ctx.storage.sql.exec<{ state: string }>(
          'SELECT state FROM engine_lifecycle WHERE id = 1',
        ),
      ][0];
      const state = row
        ? (JSON.parse(row.state) as Record<string, unknown>)
        : {};
      const pending =
        [
          ...this.ctx.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM pending_messages',
          ),
        ][0]?.count ?? 0;
      const checkpoint = state.checkpoint as { generation?: string } | null;
      let health: { helperReady: boolean; gatewayState: string } | undefined;
      if (this.ctx.container?.running) {
        const control = new PrivateContainer({
          state: this.ctx,
          env: this.env,
        } as ConstructorParameters<typeof PrivateContainer>[0]);
        health = await control.health().catch(() => undefined);
      }
      const engine = (
        this as unknown as { engine?: { gateway: { ready: boolean } } }
      ).engine;

      return Response.json({
        healthObservations: healthObservations(this.ctx.storage),
        retryAt: typeof state.retryAt === 'number' ? state.retryAt : null,
        nextAt: typeof state.nextAt === 'number' ? state.nextAt : null,
        retryPhase:
          typeof state.retryPhase === 'string' &&
          [
            'waking',
            'initializing',
            'restoring',
            'connecting',
            'ready',
          ].includes(state.retryPhase)
            ? state.retryPhase
            : null,
        timings: [
          ...(
            await this.ctx.storage.list({
              prefix: `acceptance-timing-${typeof state.bootId === 'string' ? state.bootId : 'none'}-`,
            })
          ).values(),
        ],
        construction: this.construction,
        helperReady: health?.helperReady ?? false,
        gatewayProcess: health?.gatewayState ?? null,
        sdkReady: engine?.gateway.ready ?? false,
        phase: state.phase ?? 'asleep',
        initialized: state.initialized ?? false,
        bootId: state.bootId ?? null,
        generation: checkpoint?.generation ?? null,
        failure: state.failure ?? null,
        running: this.ctx.container?.running ?? false,
        pending,
        sampledAt: Date.now(),
      });
    }
    if (path === '/__acceptance/alarm' && request.method === 'POST') {
      await this.alarm();
      return Response.json({ ok: true });
    }
    if (path === '/__acceptance/restart-gateway' && request.method === 'POST') {
      const control = new PrivateContainer({
        state: this.ctx,
        env: this.env,
      } as ConstructorParameters<typeof PrivateContainer>[0]);
      return restartGateway(control);
    }
    if (path === '/__acceptance/restart-manager' && request.method === 'POST') {
      await this.ctx.storage.setAlarm(Date.now() + 1);
      this.ctx.waitUntil(
        new Promise<void>((resolve) => setTimeout(resolve, 100)).then(() =>
          this.ctx.abort('Acceptance manager reconstruction'),
        ),
      );
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }
}
export default {
  fetch(request: Request, env: ManagerEnv): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/__acceptance/'))
      return production.fetch(request, env);
    return env.MANAGERS.get(
      env.MANAGERS.idFromName(env.MANAGER_ID ?? 'primary'),
    ).fetch(request);
  },
} satisfies ExportedHandler<ManagerEnv>;
