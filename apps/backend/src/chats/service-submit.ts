import type { PendingMessage } from '@messenger/contracts';

import { pending as readPending } from './service-catalog.js';
import { mapping } from './service-record.js';
import { changed, retry, withLock } from './service-runtime.js';
import type { ServiceState } from './service-state.js';
export async function submit(
  ctx: ServiceState,
  id: string,
  item: PendingMessage,
  behavior: 'queue' | 'steer',
): Promise<void> {
  if (ctx.closed) return;
  const epoch = ctx.connectionEpoch;
  const revision = item.revision;
  const submissionId = item.submissionId;
  const owned = () =>
    readPending(ctx, id).find(
      (candidate) =>
        candidate.id === item.id &&
        candidate.state === 'submitting' &&
        candidate.revision === revision &&
        candidate.submissionId === submissionId,
    );
  let invoked = false;
  try {
    const chat = ctx.store.getChat(id);
    if (!ctx.store.submissionScope(item.id)) {
      const history = await ctx.gateway.history(mapping(chat), {
        inputRunIds: [item.submissionId],
      });
      const retained = await withLock(ctx, id, () => {
        if (ctx.closed || !owned()) return Promise.resolve(false);
        if (
          history.sessionId &&
          epoch === ctx.connectionEpoch &&
          ctx.gateway.ready
        )
          ctx.store.saveSubmissionScope(item.id, history.sessionId);
        return Promise.resolve(true);
      });
      if (!retained) return;
    }
    const attachments = item.attachments.length
      ? await ctx.media?.payload(item.attachments, chat.settings, mapping(chat))
      : undefined;
    const invocation = await withLock(ctx, id, () => {
      if (ctx.closed) return Promise.resolve(null);
      const pending = owned();
      if (!pending) return Promise.resolve(null);
      const current = ctx.store.getChat(id);
      if (current.status === 'deleting') return Promise.resolve(null);
      const operation = ctx.store.settingsOperation(id);
      if (
        !ctx.gateway.ready ||
        epoch !== ctx.connectionEpoch ||
        current.status === 'creating' ||
        current.status === 'recovery' ||
        current.agentId !== chat.agentId ||
        current.sessionKey !== chat.sessionKey ||
        JSON.stringify(current.settings) !== JSON.stringify(chat.settings) ||
        operation?.status === 'applying' ||
        operation?.status === 'unknown' ||
        operation?.policy === 'cancel-work' ||
        (behavior === 'queue' && ctx.streams.has(id)) ||
        (behavior === 'steer' && !ctx.streams.has(id))
      ) {
        // No Gateway invocation occurred: retain durable work for the next valid claim.
        pending.state = 'pending';
        ctx.store.savePending(pending);
        changed(ctx, id);
        retry(ctx, id);
        return Promise.resolve(null);
      }
      // Invoke under the chat lock, but wrap the ACK promise so the lock never waits on network.
      invoked = true;
      return Promise.resolve({
        ack: ctx.gateway.send(
          mapping(current),
          submissionId,
          pending.text,
          behavior,
          attachments,
        ),
      });
    });
    if (!invocation) return;
    const accepted = await invocation.ack;
    if (ctx.closed) return;
    await withLock(ctx, id, () => {
      const pending = owned();
      if (!pending) return Promise.resolve();
      const current = ctx.store.getChat(id);
      if (
        current.status === 'deleting' ||
        ctx.terminalRuns.has(`${id}:${accepted.runId}`)
      )
        return Promise.resolve();
      pending.submissionId = accepted.runId;
      pending.state = 'submitted';
      ctx.store.savePending(pending);
      if (!ctx.streams.has(id))
        ctx.streams.set(id, { id: accepted.runId, text: '', sequence: 0 });
      current.status = 'running';
      ctx.store.saveChat(current);
      changed(ctx, id);
      return Promise.resolve();
    });
  } catch {
    if (ctx.closed) return;
    const retained = await withLock(ctx, id, () => {
      const pending = owned();
      if (!pending) return Promise.resolve(false);
      const current = ctx.store.getChat(id);
      if (current.status === 'deleting') return Promise.resolve(false);
      pending.state = invoked ? 'unknown' : 'pending';
      ctx.store.savePending(pending);
      current.status =
        invoked ||
        readPending(ctx, id).some((entry) => entry.state === 'unknown')
          ? 'recovery'
          : ctx.streams.has(id)
            ? 'running'
            : 'idle';
      ctx.store.saveChat(current);
      changed(ctx, id);
      return Promise.resolve(true);
    });
    if (!invoked && retained) retry(ctx, id);
  }
}
