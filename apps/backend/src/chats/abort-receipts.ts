import type { PendingMessage } from '@messenger/contracts';
import type { Store } from '../storage/store.js';

type Request = {
  message_id: string;
  request_id: string;
  revision: number;
  submission_id: string;
  session_id: string;
};
export type Captured = Request & {
  chatId: string;
  agentId: string;
  sessionKey: string;
};
const matches = (
  request: Request,
  item: PendingMessage,
  scope: string | null,
) =>
  request.message_id === item.id &&
  request.revision === item.revision &&
  request.submission_id === item.submissionId &&
  request.session_id === scope &&
  item.state !== 'pending';

/** Original authorized rows/scopes are sealed before history can yield. No owner is guessed. */
export function captureAbortRequests(
  store: Store,
  before: PendingMessage[],
): Captured[] {
  return store.db.transaction(() =>
    before.flatMap((item) => {
      const scope = store.submissionScope(item.id);
      const chat = store.getChat(item.chatId);
      if (!scope || !chat.agentId || !chat.sessionKey) return [];
      const existing = store.db
        .prepare('SELECT * FROM pending_abort_requests WHERE message_id=?')
        .get(item.id) as Request | undefined;
      if (existing && matches(existing, item, scope))
        return [
          {
            ...existing,
            chatId: item.chatId,
            agentId: chat.agentId,
            sessionKey: chat.sessionKey,
          },
        ];
      // A new tuple gets new identity; prior receipts cannot cross deletion/revision/reset.
      store.db
        .prepare('DELETE FROM pending_abort_requests WHERE message_id=?')
        .run(item.id);
      const request: Captured = {
        message_id: item.id,
        request_id: crypto.randomUUID(),
        revision: item.revision,
        submission_id: item.submissionId,
        session_id: scope,
        chatId: item.chatId,
        agentId: chat.agentId,
        sessionKey: chat.sessionKey,
      };
      store.db
        .prepare('INSERT INTO pending_abort_requests VALUES (?,?,?,?,?)')
        .run(
          request.message_id,
          request.request_id,
          request.revision,
          request.submission_id,
          request.session_id,
        );
      return [request];
    }),
  )();
}

/** Retain the same request nonce, original row tuple and scope at every phase. */
export function currentAbortRequest(
  store: Store,
  request: Captured,
): PendingMessage | undefined {
  const item = store
    .pending(request.chatId)
    .find((entry) => entry.id === request.message_id);
  const current = store.db
    .prepare('SELECT * FROM pending_abort_requests WHERE message_id=?')
    .get(request.message_id) as Request | undefined;
  const chat = item ? store.getChat(request.chatId) : undefined;
  return item &&
    chat?.agentId === request.agentId &&
    chat.sessionKey === request.sessionKey &&
    current?.request_id === request.request_id &&
    matches(request, item, store.submissionScope(item.id))
    ? item
    : undefined;
}

/** Record authenticated native ACK bytes, independently of canonical visibility. */
export function rememberAbortAck(
  store: Store,
  captured: Captured[],
  runId: string | undefined,
): void {
  if (!runId || runId !== runId.trim()) return;
  store.db.transaction(() => {
    for (const request of captured) {
      if (!currentAbortRequest(store, request)) continue;
      store.db
        .prepare('INSERT OR IGNORE INTO pending_abort_receipts VALUES (?,?)')
        .run(request.request_id, runId);
    }
  })();
}

/** A receipt proves cancellation only after fresh canonical ownership agrees exactly. */
export function hasAbortAck(
  store: Store,
  item: PendingMessage,
  scope: string,
  owner: string,
): boolean {
  return Boolean(
    store.db
      .prepare(
        `SELECT 1 FROM pending_abort_requests q JOIN pending_abort_receipts r ON r.request_id=q.request_id
     WHERE q.message_id=? AND q.revision=? AND q.submission_id=? AND q.session_id=? AND r.run_id=?`,
      )
      .get(item.id, item.revision, item.submissionId, scope, owner),
  );
}
