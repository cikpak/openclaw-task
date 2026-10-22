import {
  captureAbortRequests,
  currentAbortRequest,
  rememberAbortAck,
  hasAbortAck,
} from './abort-receipts.js';
import {
  rememberInputCancellations,
  confirmedInputCancellation,
} from './input-cancellations.js';
import type { PendingMessage } from '@messenger/contracts';
import type { ChatRecord, Store } from '../storage/store.js';
import type { Gateway, GatewayHistory } from '../gateway/types.js';
import { mapping } from './service-record.js';
import { historyWithReceipts } from './history.js';

type Intent = {
  revision: number;
  submission_id: string;
  session_id: string;
  owner_run_id: string;
  confirmed: number;
};
const exact = (item: PendingMessage, prior: PendingMessage) =>
  item.id === prior.id &&
  item.revision === prior.revision &&
  item.submissionId === prior.submissionId &&
  item.state !== 'pending';

/** Only explicit app Stop/cancel-work calls this path; deletion does not create
 * cancellation authority. Intent alone never resolves an uncertain input. */
export async function abortAcceptedInputs(
  store: Store,
  gateway: Gateway,
  chat: ChatRecord,
): Promise<void> {
  if (!gateway.nativeAbortProofs) {
    await gateway.abort(mapping(chat));
    return;
  }
  const before = store
    .pending(chat.id)
    .filter((item) => item.state !== 'pending');
  const requests = captureAbortRequests(store, before);
  let history: GatewayHistory | undefined;
  try {
    if (before.length)
      history = await historyWithReceipts(
        gateway,
        mapping(chat),
        before.map((item) => item.submissionId),
      );
  } catch {
    /* Stop remains available during history outages; no proof is inferred. */
  }
  const registered = new Map<string, string>();
  store.db.transaction(() => {
    for (const prior of before) {
      const request = requests.find((entry) => entry.message_id === prior.id);
      const item = request && currentAbortRequest(store, request);
      const owners = history?.nativeInputOwners?.filter(
        (entry) => entry.inputId === prior.submissionId,
      );
      const owner = owners?.length === 1 ? owners[0]?.runId : undefined;
      if (
        !item ||
        !owner ||
        !history?.sessionId ||
        request?.session_id !== history.sessionId
      )
        continue;
      store.db
        .prepare(
          `INSERT INTO pending_cancellations VALUES (?, ?, ?, ?, ?, 0)
        ON CONFLICT(message_id) DO UPDATE SET
        confirmed=CASE WHEN revision=excluded.revision AND submission_id=excluded.submission_id AND session_id=excluded.session_id AND owner_run_id=excluded.owner_run_id THEN confirmed ELSE 0 END,
        revision=excluded.revision,submission_id=excluded.submission_id,session_id=excluded.session_id,owner_run_id=excluded.owner_run_id`,
        )
        .run(
          item.id,
          item.revision,
          item.submissionId,
          history.sessionId,
          owner,
        );
      registered.set(item.id, owner);
    }
  })();
  const confirm = (abortedRunId: string | undefined) => {
    if (!abortedRunId) return;
    store.db.transaction(() => {
      for (const id of registered.keys()) {
        const request = requests.find((entry) => entry.message_id === id);
        const item = request && currentAbortRequest(store, request);
        if (!item || !before.some((prior) => exact(item, prior))) continue;
        store.db
          .prepare(
            `UPDATE pending_cancellations SET confirmed=1 WHERE message_id=? AND revision=? AND submission_id=? AND session_id=? AND owner_run_id=?`,
          )
          .run(
            id,
            item.revision,
            item.submissionId,
            store.submissionScope(id),
            abortedRunId,
          );
      }
    })();
  };
  const errors: unknown[] = [];
  if (gateway.abortRun) {
    for (const owner of new Set(registered.values())) {
      try {
        const acknowledgement = await gateway.abortRun(mapping(chat), owner);
        // Native exact execution ACK only; never translate a logical input ID.
        if (acknowledgement?.abortedRunId === owner) confirm(owner);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (gateway.abortChat) {
    try {
      const acknowledgement = await gateway.abortChat(mapping(chat));
      for (const id of acknowledgement?.runIds ?? [])
        rememberAbortAck(store, requests, id);
      rememberInputCancellations(
        store,
        requests,
        acknowledgement?.inputs ?? [],
      );
    } catch (error) {
      errors.push(error);
    }
  }
  // A run selector intentionally omits native session-wide queued/cascade cleanup.
  // Always retain the existing broad action, including after a targeted failure.
  try {
    const acknowledgement = await gateway.abort(mapping(chat));
    rememberAbortAck(store, requests, acknowledgement?.abortedRunId);
    confirm(acknowledgement?.abortedRunId);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, 'Native Stop did not fully settle');
}

export function confirmedCancellation(
  store: Store,
  item: PendingMessage,
  history: GatewayHistory,
): boolean {
  if (confirmedInputCancellation(store, item, history)) return true;
  const proof = store.db
    .prepare('SELECT * FROM pending_cancellations WHERE message_id=?')
    .get(item.id) as Intent | undefined;
  const owners = history.nativeInputOwners?.filter(
    (owner) => owner.inputId === item.submissionId,
  );
  const owner = owners?.length === 1 ? owners[0]?.runId : undefined;
  if (
    !owner ||
    !history.sessionId ||
    history.activeRun?.id === owner ||
    history.sessionId !== store.submissionScope(item.id)
  )
    return false;
  const sameIntent =
    proof &&
    proof.revision === item.revision &&
    proof.submission_id === item.submissionId &&
    proof.session_id === history.sessionId;
  // A known original owner cannot be replaced by a different later association.
  if (sameIntent && proof.owner_run_id !== owner) return false;
  return (
    hasAbortAck(store, item, history.sessionId, owner) ||
    Boolean(sameIntent && proof.confirmed)
  );
}
