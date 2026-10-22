import type { GatewayEvent } from '../gateway/types.js';
import { appendPreview } from './projection.js';
import { saveTool } from './tools.js';

import { pending } from './service-catalog.js';
import { schedule } from './service-dispatch.js';
import { localSnapshot, refresh } from './service-history.js';
import { reconcile } from './service-reconcile.js';
import { changed, publish, withLock } from './service-runtime.js';
import type { ServiceState } from './service-state.js';
export async function handleGatewayEvent(
  ctx: ServiceState,
  event: GatewayEvent,
): Promise<void> {
  if (ctx.closed) return;
  if (event.type === 'connection') {
    const epoch = ++ctx.connectionEpoch;
    ctx.streams.clear();
    ctx.settled.clear();
    if (event.ready) await reconcile(ctx);
    else ctx.reconciled = false;
    if (epoch !== ctx.connectionEpoch) return;
    publish(ctx, {
      type: 'connection.state',
      state: event.ready && ctx.reconciled ? 'ready' : 'unavailable',
    });
    return;
  }
  const chat = ctx.store
    .listChats()
    .find((candidate) => candidate.sessionKey === event.sessionKey);
  if (!chat || chat.status === 'deleting') return;
  if (event.type === 'tool') {
    const projected = saveTool(ctx.store, chat.id, event.tool, event.sequence);
    if (projected) {
      ctx.stateEpochs.set(chat.id, (ctx.stateEpochs.get(chat.id) ?? 0) + 1);
      publish(ctx, {
        type: 'conversation.tool',
        chatId: chat.id,
        tool: projected,
      });
      publish(ctx, {
        type: 'conversation.snapshot',
        snapshot: localSnapshot(ctx, chat.id),
      });
    }
    return;
  }
  const key = `${chat.id}:${event.runId}`;
  if (
    ctx.terminalRuns.has(key) ||
    (ctx.runSequences.get(key) ?? -1) >= event.sequence
  )
    return;
  ctx.runSequences.set(key, event.sequence);
  if (event.state === 'delta') {
    const old = ctx.streams.get(chat.id);
    if (old && old.id !== event.runId) return;
    if (old && old.sequence >= event.sequence) return;
    ctx.settled.discard(chat.id);
    ctx.stateEpochs.set(chat.id, (ctx.stateEpochs.get(chat.id) ?? 0) + 1);
    const preview = appendPreview(
      old,
      event.runId,
      event.text,
      event.replace,
      event.sequence,
    );
    ctx.streams.set(chat.id, preview);
    if (old?.truncated && preview.truncated && old.text === preview.text)
      return;
    const replace = event.replace || preview.truncated === true;
    publish(ctx, {
      type: 'conversation.run.text',
      chatId: chat.id,
      runId: event.runId,
      text: replace ? preview.text : event.text,
      replace,
      truncated: preview.truncated === true,
      runSequence: event.sequence,
    });
    return;
  }
  if (event.state === 'status') return;
  if (
    ctx.streams.get(chat.id)?.id !== event.runId &&
    !pending(ctx, chat.id).some((item) => item.submissionId === event.runId)
  )
    return;
  ctx.terminalRuns.add(key);
  if (ctx.terminalRuns.size > 500) {
    const oldest = ctx.terminalRuns.values().next().value;
    if (oldest) {
      ctx.terminalRuns.delete(oldest);
      ctx.runSequences.delete(oldest);
    }
  }
  const terminalState = event.state;
  await withLock(ctx, chat.id, () => {
    const current = ctx.store.getChat(chat.id);
    if (current.status === 'deleting') return Promise.resolve();
    ctx.settled.capture(
      chat.id,
      ctx.streams.get(chat.id)?.id === event.runId
        ? ctx.streams.get(chat.id)
        : undefined,
      terminalState,
      localSnapshot(ctx, chat.id).messages,
    );
    if (ctx.streams.get(chat.id)?.id === event.runId)
      ctx.streams.delete(chat.id);
    for (const item of pending(ctx, chat.id))
      if (item.submissionId === event.runId) ctx.store.removePending(item.id);
    current.status = ctx.streams.has(chat.id) ? 'running' : 'idle';
    current.unread = true;
    ctx.store.saveChat(current);
    changed(ctx, chat.id);
    return Promise.resolve();
  });
  try {
    await refresh(ctx, chat.id);
  } finally {
    schedule(ctx, chat.id);
  }
}
