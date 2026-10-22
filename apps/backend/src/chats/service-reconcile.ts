import type { ChatSettings, SettingsOperation } from '@messenger/contracts';
import { ConflictError } from '../errors.js';
import type { GatewayMapping } from '../gateway/types.js';
import { requireVersion } from './queue.js';

import { schedule } from './service-dispatch.js';
import { refresh } from './service-history.js';
import { changed, publish, withLock } from './service-runtime.js';
import type { ServiceState } from './service-state.js';
export function reconcile(ctx: ServiceState): Promise<void> {
  if (ctx.reconciliation) return ctx.reconciliation;
  const work = reconcileAll(ctx).finally(() => {
    ctx.reconciliation = null;
  });
  ctx.reconciliation = work;
  return work;
}
export async function reconcileAll(ctx: ServiceState): Promise<void> {
  const epoch = ctx.connectionEpoch;
  let successful = true;
  ctx.reconciled = false;
  for (const chat of ctx.store.listChats()) {
    if (epoch !== ctx.connectionEpoch || !ctx.gateway.ready || ctx.closed)
      return;
    if (chat.status === 'deleting') {
      schedule(ctx, chat.id);
      continue;
    }
    if (!chat.agentId || !chat.sessionKey) {
      if (!ctx.gateway.recoverCreation) continue;
      let found: GatewayMapping | null;
      try {
        found = await ctx.gateway.recoverCreation(chat.id, chat.settings);
      } catch {
        successful = false;
        continue;
      }
      if (epoch !== ctx.connectionEpoch || ctx.closed) return;
      if (!found) continue;
      const current = ctx.store.getChat(chat.id);
      current.agentId = found.agentId;
      current.sessionKey = found.sessionKey;
      ctx.store.saveChat(current);
    }
    try {
      await refresh(ctx, chat.id);
    } catch {
      successful = false;
    }
    schedule(ctx, chat.id);
  }
  if (ctx.gateway.lookupCreation) {
    const tombstones = ctx.store.tombstones();
    for (const chat of tombstones.slice(
      ctx.tombstoneOffset,
      ctx.tombstoneOffset + 10,
    )) {
      let found: GatewayMapping | null;
      try {
        found = await ctx.gateway.lookupCreation(chat.id);
      } catch {
        successful = false;
        continue;
      }
      if (epoch !== ctx.connectionEpoch || ctx.closed) return;
      if (found) {
        try {
          await ctx.gateway.abort(found);
        } catch {
          /* An uncertain creation may have no session to abort. */
        }
        try {
          await ctx.gateway.remove(found);
        } catch {
          successful = false;
        }
      }
    }
    ctx.tombstoneOffset =
      ctx.tombstoneOffset + 10 >= tombstones.length
        ? 0
        : ctx.tombstoneOffset + 10;
  }
  if (epoch !== ctx.connectionEpoch || ctx.closed) return;
  ctx.reconciled =
    successful && epoch === ctx.connectionEpoch && ctx.gateway.ready;
  publish(ctx, {
    type: 'connection.state',
    state: ctx.reconciled ? 'ready' : 'unavailable',
  });
}
export async function resolveSettings(
  ctx: ServiceState,
  id: string,
  action: 'retry' | 'discard',
  version?: string,
): Promise<{
  effective: ChatSettings;
  pending: SettingsOperation | null;
  version: number;
}> {
  requireVersion(ctx.store.getChat(id).version, version);
  await refresh(ctx, id);
  const result = await withLock(ctx, id, () => {
    const chat = ctx.store.getChat(id);
    requireVersion(chat.version, version);
    const operation = ctx.store.settingsOperation(id);
    if (operation) {
      if (operation.status !== 'unknown')
        throw new ConflictError(
          'SETTINGS_CHANGED',
          'This settings operation changed. Reload before continuing.',
        );
      if (action === 'discard') ctx.store.saveSettingsOperation(id, null);
      else {
        operation.status = 'pending';
        ctx.store.saveSettingsOperation(id, operation);
      }
      chat.version += 1;
      ctx.store.saveChat(chat);
      changed(ctx, id);
    }
    return Promise.resolve({
      effective: chat.settings,
      pending: ctx.store.settingsOperation(id),
      version: chat.version,
    });
  });
  schedule(ctx, id);
  return result;
}
