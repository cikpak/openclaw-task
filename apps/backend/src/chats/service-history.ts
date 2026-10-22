import type { ChatSnapshot } from '@messenger/contracts';
import { z } from 'zod';
import type {
  Gateway,
  GatewayHistory,
  GatewayMapping,
} from '../gateway/types.js';
import { snapshotSchema } from '../schemas.js';
import { historyWithReceipts } from './history.js';
import { boundedPending, boundedRun } from './projection.js';
import { hasWork, reconcileInputs } from './queue.js';
import { saveTool, tools } from './tools.js';

import { pending } from './service-catalog.js';
import { mapping, summary } from './service-record.js';
import { changed, retryRefresh, withLock } from './service-runtime.js';
import type { ServiceState } from './service-state.js';
import { locallyUninvoked } from './submission-claims.js';
export function beginRead(
  ctx: ServiceState,
  id: string,
): {
  state: number;
  read: number;
} {
  const read = (ctx.readEpochs.get(id) ?? 0) + 1;
  ctx.readEpochs.set(id, read);
  return { state: ctx.stateEpochs.get(id) ?? 0, read };
}
export function currentRead(
  ctx: ServiceState,
  id: string,
  epoch: {
    state: number;
    read: number;
  },
): boolean {
  return (
    epoch.state === (ctx.stateEpochs.get(id) ?? 0) &&
    epoch.read === ctx.readEpochs.get(id)
  );
}
export function projectHistory(
  ctx: ServiceState,
  id: string,
  history: GatewayHistory,
): GatewayHistory {
  // Native terminal publication can precede controller cleanup in chat.history.
  // Exact terminal evidence outranks that transient snapshot, never a different run.
  return history.activeRun &&
    ctx.terminalRuns.has(`${id}:${history.activeRun.id}`)
    ? { ...history, activeRun: null }
    : history;
}
export function localSnapshot(ctx: ServiceState, id: string): ChatSnapshot {
  if (ctx.streams.has(id) || ctx.store.getChat(id).status === 'deleting')
    ctx.settled.discard(id);
  const row = ctx.store.db
    .prepare('SELECT json FROM chat_history WHERE chat_id = ?')
    .get(id);
  const cached = row ? z.object({ json: z.string() }).parse(row).json : null;
  const history = cached
    ? z
        .object({
          messages: snapshotSchema.shape.messages,
          hasOlderHistory: z.boolean(),
          historyCursor: z.string().nullable(),
        })
        .parse(JSON.parse(cached))
    : null;
  const queue = boundedPending(ctx.store, id);
  return {
    chat: summary(ctx.store.getChat(id)),
    messages: history?.messages ?? [],
    pending: queue.pending,
    hiddenPendingCount: queue.hiddenPendingCount,
    activeRun: boundedRun(ctx.streams.get(id) ?? null),
    ...(ctx.settled.get(id) ? { settledRun: ctx.settled.get(id) } : {}),
    pendingSettings: ctx.store.settingsOperation(id),
    tools: tools(ctx.store, id),
    hasOlderHistory: history?.hasOlderHistory ?? false,
    historyCursor: history?.historyCursor ?? null,
  };
}
export function cacheHistory(
  ctx: ServiceState,
  id: string,
  data: GatewayHistory,
): void {
  data = projectHistory(ctx, id, data);
  ctx.settled.reconcile(id, data.messages, data.activeRun);
  for (const tool of data.tools ?? []) saveTool(ctx.store, id, tool, -1);
  const snapshot = {
    ...localSnapshot(ctx, id),
    messages: data.messages,
    activeRun: boundedRun(data.activeRun),
    hasOlderHistory: data.hasOlderHistory,
    historyCursor: data.historyCursor,
  };
  ctx.store.db
    .prepare(
      'INSERT INTO chat_history VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json',
    )
    .run(
      id,
      JSON.stringify(
        ctx.projectSnapshot?.(snapshotSchema.parse(snapshot)) ??
          snapshotSchema.parse(snapshot),
      ),
    );
}
export async function snapshot(
  ctx: ServiceState,
  id: string,
  refreshEngine = true,
): Promise<ChatSnapshot> {
  const chat = ctx.store.getChat(id);
  if (
    refreshEngine &&
    ctx.gateway.ready &&
    chat.agentId &&
    chat.sessionKey &&
    chat.status !== 'deleting'
  ) {
    const epoch = ctx.connectionEpoch;
    const observation = beginRead(ctx, id);
    try {
      const history = await ctx.gateway.history(mapping(chat));
      if (
        !ctx.closed &&
        epoch === ctx.connectionEpoch &&
        currentRead(ctx, id, observation)
      )
        cacheHistory(ctx, id, history);
    } catch {
      /* Cached state and accepted queues remain available offline. */
    }
  }
  return snapshotSchema.parse(localSnapshot(ctx, id));
}
export async function refresh(ctx: ServiceState, id: string): Promise<void> {
  const chat = ctx.store.getChat(id);
  const epoch = ctx.connectionEpoch;
  const observation = beginRead(ctx, id);
  const history = await historyWithReceipts(
    ctx.gateway,
    mapping(chat),
    pending(ctx, id)
      .filter((item) => item.state !== 'pending')
      .map((item) => item.submissionId),
  );
  if (epoch !== ctx.connectionEpoch || ctx.closed || !ctx.gateway.ready) return;
  await withLock(ctx, id, () => {
    if (!currentRead(ctx, id, observation)) {
      retryRefresh(ctx, id);
      return Promise.resolve();
    }
    const current = ctx.store.getChat(id);
    if (current.status === 'deleting') return Promise.resolve();
    const observed = projectHistory(ctx, id, history);
    reconcileInputs(ctx.store, id, observed, (item) =>
      locallyUninvoked(ctx, item),
    );
    if (observed.activeRun) {
      const preview = boundedRun(observed.activeRun);
      if (preview) ctx.streams.set(id, preview);
      const key = `${id}:${observed.activeRun.id}`;
      ctx.runSequences.set(
        key,
        Math.max(ctx.runSequences.get(key) ?? -1, observed.activeRun.sequence),
      );
    } else ctx.streams.delete(id);
    current.settings = history.settings;
    current.status = pending(ctx, id).some((item) => item.state === 'unknown')
      ? 'recovery'
      : observed.activeRun
        ? 'running'
        : 'idle';
    const operation = ctx.store.settingsOperation(id);
    if (
      operation &&
      (operation.status === 'unknown' || operation.status === 'applying')
    ) {
      if (
        JSON.stringify(operation.settings) ===
          JSON.stringify(history.settings) &&
        (operation.policy !== 'cancel-work' ||
          !hasWork(ctx.store, id, Boolean(observed.activeRun)))
      )
        ctx.store.saveSettingsOperation(id, null);
      else {
        operation.status = 'unknown';
        ctx.store.saveSettingsOperation(id, operation);
      }
    }
    ctx.store.saveChat(current);
    cacheHistory(ctx, id, observed);
    changed(ctx, id);
    return Promise.resolve();
  });
  const subscribe = (
    ctx.gateway as Gateway & {
      subscribe?: (target: GatewayMapping) => Promise<void>;
    }
  ).subscribe;
  if (subscribe) await subscribe.call(ctx.gateway, mapping(chat));
}
