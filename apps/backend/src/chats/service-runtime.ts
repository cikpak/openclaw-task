import type { ConversationEvent } from '@messenger/contracts';
import { parseOutboundEvent } from '../outbound.js';

import { schedule } from './service-dispatch.js';
import { localSnapshot, refresh } from './service-history.js';
import { summary } from './service-record.js';
import type { EventPayload, ServiceState } from './service-state.js';
export function close(ctx: ServiceState): void {
  ctx.closed = true;
  ctx.settled.clear();
  ctx.titles.close();
  clearInterval(ctx.recoveryTimer);
  for (const timer of ctx.retryTimers.values()) clearTimeout(timer);
  for (const timer of ctx.refreshRetries.values()) clearTimeout(timer);
  ctx.unsubscribe();
}
export async function drain(ctx: ServiceState): Promise<void> {
  await Promise.all([...ctx.driving.values(), ...ctx.steering]);
  await ctx.titles.drain();
}
export function retry(ctx: ServiceState, id: string): void {
  if (ctx.retryTimers.has(id) || ctx.closed) return;
  const timer = setTimeout(() => {
    ctx.retryTimers.delete(id);
    if (ctx.store.listChats().some((chat) => chat.id === id)) schedule(ctx, id);
  }, 1000);
  timer.unref?.();
  ctx.retryTimers.set(id, timer);
}
export function retryRefresh(ctx: ServiceState, id: string): void {
  if (ctx.closed || ctx.refreshRetries.has(id)) return;
  const timer = setTimeout(() => {
    ctx.refreshRetries.delete(id);
    if (
      ctx.closed ||
      !ctx.gateway.ready ||
      !ctx.store.listChats().some((chat) => chat.id === id)
    )
      return;
    void refresh(ctx, id)
      .then(() => schedule(ctx, id))
      .catch(() => {
        ctx.reconciled = false;
      });
  }, 1000);
  timer.unref?.();
  ctx.refreshRetries.set(id, timer);
}
export function onEvent(
  ctx: ServiceState,
  listener: (event: ConversationEvent) => void,
): () => void {
  ctx.listeners.add(listener);
  return () => ctx.listeners.delete(listener);
}
export function publish(
  ctx: ServiceState,
  event: EventPayload<ConversationEvent>,
): void {
  if (ctx.closed) return;
  const frame = parseOutboundEvent({
    ...event,
    generation: ctx.generation,
    sequence: ctx.sequence + 1,
  });
  ctx.sequence = frame.sequence;
  for (const listener of ctx.listeners) {
    try {
      listener(frame);
    } catch {
      /* A failed subscriber cannot reject retained work or prevent other subscribers from receiving validated state. */
    }
  }
}
export function changed(
  ctx: ServiceState,
  chatId: string,
  affectsExecution = true,
): void {
  if (affectsExecution)
    ctx.stateEpochs.set(chatId, (ctx.stateEpochs.get(chatId) ?? 0) + 1);
  const chat = ctx.store.getChat(chatId);
  chat.updatedAt = Date.now();
  ctx.store.saveChat(chat);
  publish(ctx, { type: 'conversation.updated', chat: summary(chat) });
  publish(ctx, {
    type: 'conversation.snapshot',
    snapshot: localSnapshot(ctx, chatId),
  });
}
export async function withLock<T>(
  ctx: ServiceState,
  id: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = ctx.locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  ctx.locks.set(id, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (ctx.locks.get(id) === current) ctx.locks.delete(id);
  }
}
