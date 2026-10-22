import {
  record,
  journalResult,
  journalReceiptState,
  journalFlag,
} from './acceptance-receipt-shape.js';
type Native = {
  ready: boolean;
  request(method: string, params: unknown): Promise<unknown>;
};
/** Acceptance-only oracle: exact durable command and native user-event identity. */
export async function journalProof(
  state: DurableObjectState,
  native: Native | undefined,
  request: Request,
) {
  const body = record(await request.json());
  const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
  if (
    typeof body?.chatId !== 'string' ||
    typeof body.commandId !== 'string' ||
    !uuid.test(body.chatId) ||
    !uuid.test(body.commandId)
  )
    return journalResult({ accepted: false, journaledUser: false });
  const saved = [
    ...state.storage.sql.exec<{ json: string }>(
      'SELECT json FROM command_requests WHERE id=?',
      body.commandId,
    ),
  ][0];
  const result = [
    ...state.storage.sql.exec<{ json: string }>(
      'SELECT json FROM command_results WHERE id=?',
      body.commandId,
    ),
  ][0];
  const command = saved ? record(JSON.parse(saved.json)) : null;
  const accepted = result ? record(JSON.parse(result.json)) : null;
  if (
    command?.type !== 'conversation.message.send' ||
    command.commandId !== body.commandId ||
    command.chatId !== body.chatId ||
    accepted?.ok !== true ||
    accepted.commandId !== body.commandId ||
    record(accepted.data)?.messageId !== body.commandId
  )
    return journalResult({ accepted: false, journaledUser: false });
  const mapping = [
    ...state.storage.sql.exec<{ agent_id: string; session_key: string }>(
      'SELECT agent_id,session_key FROM chats WHERE id=?',
      body.chatId,
    ),
  ][0];
  if (!mapping || !native?.ready)
    return journalResult({
      accepted: true,
      journaledUser: false,
      nativeReady: native?.ready ?? false,
    });
  let offset = 0;
  let anchor: { sessionId: string; total: number } | undefined;
  const deadline = Date.now() + 30000;
  do {
    let raw: Record<string, unknown> | null;
    try {
      raw = record(
        await native.request('chat.history', {
          agentId: mapping.agent_id,
          sessionKey: mapping.session_key,
          limit: 50,
          maxBytes: 262144,
          inputRunIds: [body.commandId],
          ...(offset ? { offset } : {}),
        }),
      );
    } catch {
      return journalFlag('nativeReadFailed');
    }
    if (
      typeof raw?.sessionId !== 'string' ||
      !raw.sessionId ||
      raw.sessionKey !== mapping.session_key ||
      !Number.isSafeInteger(raw.totalMessages) ||
      Number(raw.totalMessages) < 0 ||
      (anchor &&
        (anchor.sessionId !== raw.sessionId ||
          anchor.total !== raw.totalMessages))
    )
      return journalFlag('historyChanged');
    anchor ??= { sessionId: raw.sessionId, total: Number(raw.totalMessages) };
    const receipt = journalReceiptState(raw, body.commandId);
    if (receipt)
      return journalResult({
        accepted: true,
        queryScoped: true,
        [receipt === 'pending'
          ? 'pendingReceipt'
          : receipt === 'cancelled'
            ? 'cancelledReceipt'
            : 'receiptContradiction']: true,
      });
    const messages = Array.isArray(raw?.messages) ? raw.messages : [];
    for (const value of messages) {
      const message = record(value);
      const meta = record(message?.__openclaw);
      const exactKey =
        meta?.idempotencyKey === body.commandId ||
        meta?.idempotencyKey === `${body.commandId}:user`;
      const stableId =
        typeof meta?.id === 'string' &&
        meta.id.length > 0 &&
        !meta.id.startsWith('pending:');
      const positiveSequence =
        Number.isSafeInteger(meta?.seq) && Number(meta?.seq) > 0;
      if (message?.role === 'user' && exactKey && stableId && positiveSequence)
        return journalResult({
          accepted: true,
          queryScoped: true,
          journaledUser: true,
          stableId,
          positiveSequence,
        });
    }
    if (raw.hasMore === false)
      return journalResult({ accepted: true, queryScoped: true });
    if (raw.hasMore !== true || !messages.length)
      return journalFlag('scanIncomplete');
    if (
      !Number.isSafeInteger(raw.nextOffset) ||
      Number(raw.nextOffset) <= offset
    )
      return journalFlag('paginationInvalid');
    offset = Number(raw.nextOffset);
  } while (Date.now() < deadline);
  return journalFlag('scanIncomplete');
}
