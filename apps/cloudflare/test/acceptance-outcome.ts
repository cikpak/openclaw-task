import { outcomeShape } from './acceptance-outcome-shape.js';
import { record } from './acceptance-receipt-shape.js';
import { acceptedCommand } from './acceptance-command.js';
type Native = {
  ready: boolean;
  request(method: string, params: unknown): Promise<unknown>;
};
/** Read-only synthetic command outcome evidence; no raw identities or text escape. */
export async function outcomeProof(
  state: DurableObjectState,
  native: Native | undefined,
  request: Request,
) {
  const body = record(await request.json());
  const input = acceptedCommand(state, body);
  const parent =
    body?.parentCommandId === undefined
      ? null
      : acceptedCommand(state, {
          chatId: body.chatId,
          commandId: body.parentCommandId,
        });
  if (!input || (body?.parentCommandId !== undefined && !parent))
    return { accepted: false };
  if (!native?.ready) return { accepted: true, nativeReady: false };
  const messages: Record<string, unknown>[] = [];
  let offset = 0,
    anchor: { sessionId: string; total: number } | undefined;
  let inFlight: unknown;
  let receipts: unknown[] = [],
    consumptions: unknown[] = [];
  const deadline = Date.now() + 30000;
  do {
    let raw;
    try {
      raw = record(
        await native.request('chat.history', {
          agentId: input.mapping.agent_id,
          sessionKey: input.mapping.session_key,
          inputRunIds: [input.commandId],
          limit: 50,
          maxBytes: 262144,
          ...(offset ? { offset } : {}),
        }),
      );
    } catch {
      return { accepted: true, nativeReadFailed: true };
    }
    if (
      typeof raw?.sessionId !== 'string' ||
      !raw.sessionId ||
      raw.sessionKey !== input.mapping.session_key ||
      !Number.isSafeInteger(raw.totalMessages) ||
      Number(raw.totalMessages) < 0 ||
      (anchor &&
        (anchor.sessionId !== raw.sessionId ||
          anchor.total !== raw.totalMessages))
    )
      return { accepted: true, historyChanged: true };
    anchor ??= { sessionId: raw.sessionId, total: Number(raw.totalMessages) };
    inFlight = raw.inFlightRun;
    receipts = Array.isArray(raw.inputReceipts) ? raw.inputReceipts : [];
    consumptions = Array.isArray(raw.inputConsumptions)
      ? raw.inputConsumptions
      : [];
    const page = Array.isArray(raw.messages) ? raw.messages : [];
    messages.push(
      ...page.flatMap((value: unknown) =>
        record(value) ? [record(value)!] : [],
      ),
    );
    if (raw.hasMore === false) break;
    if (raw.hasMore !== true || !page.length || Date.now() >= deadline)
      return { accepted: true, scanIncomplete: true };
    if (
      !Number.isSafeInteger(raw.nextOffset) ||
      Number(raw.nextOffset) <= offset
    )
      return { accepted: true, paginationInvalid: true };
    offset = Number(raw.nextOffset);
  } while (Date.now() <= deadline);
  if (Date.now() > deadline) return { accepted: true, scanIncomplete: true };
  const pending = [
    ...state.storage.sql.exec<{ json: string }>(
      'SELECT json FROM pending_messages WHERE id=?',
      input.commandId,
    ),
  ][0];
  const pendingState = pending ? record(JSON.parse(pending.json))?.state : null;
  return {
    accepted: true,
    nativeReady: true,
    queryScoped: true,
    pendingState:
      typeof pendingState === 'string' &&
      ['pending', 'submitting', 'submitted', 'unknown'].includes(pendingState)
        ? pendingState
        : null,
    inFlightPresent: inFlight !== undefined && inFlight !== null,
    inFlightMatchesInput:
      inFlight === input.commandId ||
      record(inFlight)?.runId === input.commandId,
    inFlightMatchesParent:
      Boolean(parent) &&
      (inFlight === parent?.commandId ||
        record(inFlight)?.runId === parent?.commandId),
    storedScopePresent: Boolean(input.scope),
    responseSessionMatchesStoredScope:
      Boolean(input.scope) && input.scope === anchor?.sessionId,
    ...outcomeShape(messages, receipts, consumptions, input, parent, inFlight),
  };
}
