import type { PendingMessage } from '@messenger/contracts';
import type { Store } from '../storage/store.js';
import type {
  GatewayHistory,
  NativeInputCancellation,
} from '../gateway/types.js';
import { currentAbortRequest, type Captured } from './abort-receipts.js';

/** Only the native post-commit original-controller certificate has this source.
 * Generic chat/run ACKs never become input cancellation receipts. */
export function rememberInputCancellations(
  store: Store,
  captured: Captured[],
  inputs: NativeInputCancellation[],
): void {
  store.db.transaction(() => {
    for (const request of captured) {
      const item = currentAbortRequest(store, request);
      if (!item) continue;
      const matches = inputs.filter(
        (input) =>
          input.kind === 'pre-execution-input-cancelled' &&
          input.inputId === request.submission_id &&
          input.sessionId === request.session_id &&
          input.agentId === request.agentId &&
          input.sessionKey === request.sessionKey,
      );
      if (matches.length !== 1) continue;
      const input = matches[0]!;
      store.db
        .prepare(
          'INSERT OR IGNORE INTO pending_input_cancellations VALUES (?,?,?,?,?,?)',
        )
        .run(
          request.request_id,
          input.kind,
          input.inputId,
          input.sessionId,
          input.agentId,
          input.sessionKey,
        );
    }
  })();
}

export function confirmedInputCancellation(
  store: Store,
  item: PendingMessage,
  history: GatewayHistory,
): boolean {
  if (
    !history.sessionId ||
    history.sessionId !== store.submissionScope(item.id) ||
    history.activeRun ||
    history.receipts.some(
      (receipt) =>
        receipt.runId === item.submissionId && receipt.state === 'pending',
    )
  )
    return false;
  const owners =
    history.nativeInputOwners?.filter(
      (owner) => owner.inputId === item.submissionId,
    ) ?? [];
  // Absence is not proof. It is allowed only with the exact native certificate
  // queried below. Any real generated/ambiguous association remains a fence.
  if (
    owners.length > 1 ||
    owners.some((owner) => owner.runId !== item.submissionId)
  )
    return false;
  const original = store.db
    .prepare('SELECT * FROM pending_cancellations WHERE message_id=?')
    .get(item.id) as
    | {
        revision: number;
        submission_id: string;
        session_id: string;
        owner_run_id: string;
      }
    | undefined;
  if (
    original?.revision === item.revision &&
    original.submission_id === item.submissionId &&
    original.session_id === history.sessionId &&
    original.owner_run_id !== item.submissionId
  )
    return false;
  const request = store.db
    .prepare('SELECT request_id FROM pending_abort_requests WHERE message_id=?')
    .get(item.id) as { request_id: string } | undefined;
  if (
    !request ||
    !history.inputCancellationRequests?.includes(request.request_id)
  )
    return false;
  const chat = store.getChat(item.chatId);
  return Boolean(
    store.db
      .prepare(
        `SELECT 1 FROM pending_abort_requests q JOIN pending_input_cancellations p ON p.request_id=q.request_id
    WHERE q.request_id=? AND q.message_id=? AND q.revision=? AND q.submission_id=? AND q.session_id=?
    AND p.kind='pre-execution-input-cancelled' AND p.input_id=? AND p.session_id=? AND p.agent_id=? AND p.session_key=?`,
      )
      .get(
        request.request_id,
        item.id,
        item.revision,
        item.submissionId,
        history.sessionId,
        item.submissionId,
        history.sessionId,
        chat.agentId,
        chat.sessionKey,
      ),
  );
}
