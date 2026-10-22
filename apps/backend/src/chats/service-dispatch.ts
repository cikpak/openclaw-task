import type { PendingMessage } from '@messenger/contracts';
import { applySettings, completeDeletion } from './lifecycle.js';
import { hasWork } from './queue.js';

import { autoTitle, lifecycle, pending } from './service-catalog.js';
import { changed, withLock } from './service-runtime.js';
import type { DispatchClaim, ServiceState } from './service-state.js';
import { submit } from './service-submit.js';
export function startSteer(
  ctx: ServiceState,
  id: string,
  item: PendingMessage,
): void {
  const job = submit(ctx, id, item, 'steer')
    .catch(() => {
      ctx.reconciled = false;
    })
    .finally(() => {
      ctx.steering.delete(job);
    });
  ctx.steering.add(job);
}
export function schedule(ctx: ServiceState, id: string): void {
  if (ctx.closed || !ctx.gateway.ready) return;
  if (ctx.driving.has(id)) {
    ctx.driveRequested.add(id);
    return;
  }
  const job = drive(ctx, id)
    .catch(() => {
      ctx.reconciled = false;
    })
    .finally(() => {
      ctx.driving.delete(id);
      if (
        ctx.driveRequested.delete(id) &&
        !ctx.closed &&
        ctx.store.listChats().some((chat) => chat.id === id)
      )
        schedule(ctx, id);
    });
  ctx.driving.set(id, job);
}
export async function drive(ctx: ServiceState, id: string): Promise<void> {
  const claim = await withLock<DispatchClaim>(ctx, id, () => {
    if (ctx.closed || !ctx.gateway.ready) return Promise.resolve(null);
    const chat = ctx.store.getChat(id);
    if (chat.status === 'deleting')
      return Promise.resolve({ kind: 'delete' as const, chat });
    if (!chat.agentId || chat.status === 'creating')
      return Promise.resolve(null);
    const operation = ctx.store.settingsOperation(id);
    if (operation) {
      if (operation.status !== 'pending') return Promise.resolve(null);
      if (
        operation.policy === 'cancel-work' ||
        !hasWork(ctx.store, id, ctx.streams.has(id))
      ) {
        operation.status = 'applying';
        ctx.store.saveSettingsOperation(id, operation);
        changed(ctx, id);
        return Promise.resolve({
          kind: 'settings' as const,
          chat,
          operation,
        });
      }
    }
    if (chat.status === 'recovery') return Promise.resolve(null);
    if (
      ctx.streams.has(id) ||
      pending(ctx, id).some((item) => item.state !== 'pending')
    )
      return Promise.resolve(null);
    const item = pending(ctx, id).find(
      (candidate) => candidate.state === 'pending',
    );
    if (!item) return Promise.resolve(null);
    item.state = 'submitting';
    ctx.store.savePending(item);
    autoTitle(ctx, id, item.text);
    changed(ctx, id);
    return Promise.resolve({ kind: 'message' as const, item });
  });
  if (!claim || ctx.closed) return;
  if (claim.kind === 'message') {
    await submit(ctx, id, claim.item, 'queue');
    return;
  }
  if (claim.kind === 'delete') {
    await completeDeletion(lifecycle(ctx), claim.chat);
    return;
  }
  await applySettings(lifecycle(ctx), claim.chat, claim.operation);
}
