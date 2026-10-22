/** Private structural native proof for the synthetic acceptance image only. */
type Native = {
  ready: boolean;
  request(method: string, params: unknown): Promise<unknown>;
};
import { record, text, nativeSummary } from './acceptance-receipt-shape.js';
export async function receiptProof(
  state: DurableObjectState,
  native: Native | undefined,
) {
  const pending = [
    ...state.storage.sql.exec<{ json: string }>(
      'SELECT json FROM pending_messages ORDER BY position LIMIT 1',
    ),
  ][0];
  if (!pending || !native?.ready)
    return { pending: Boolean(pending), nativeReady: native?.ready ?? false };
  const input = JSON.parse(pending.json) as {
    id: string;
    chatId: string;
    submissionId?: string;
    text: string;
    state: string;
  };
  const mapping = [
    ...state.storage.sql.exec<{ agent_id: string; session_key: string }>(
      'SELECT agent_id,session_key FROM chats WHERE id=?',
      input.chatId,
    ),
  ][0];
  if (!mapping || !input.submissionId)
    return {
      pending: true,
      pendingState: input.state,
      mapping: Boolean(mapping),
    };
  const scope = [
    ...state.storage.sql.exec<{ session_id: string }>(
      'SELECT session_id FROM submission_scopes WHERE message_id=?',
      input.id,
    ),
  ][0]?.session_id;
  const matches = (value: unknown) =>
    value === input.submissionId || value === `${input.submissionId}:user`;
  const summarize = nativeSummary(matches);
  try {
    const raw = record(
      await native.request('chat.history', {
        sessionKey: mapping.session_key,
        agentId: mapping.agent_id,
        inputRunIds: [input.submissionId],
      }),
    );
    const receipts = raw?.inputReceipts;
    const messages = Array.isArray(raw?.messages) ? raw.messages : [];
    return {
      pendingState: input.state,
      nativeReady: native.ready,
      historyKeys: Object.keys(raw ?? {}),
      hasInputReceipts: receipts !== undefined,
      responseSessionIdPresent: typeof raw?.sessionId === 'string',
      storedScopePresent: Boolean(scope),
      responseSessionMatchesStoredScope:
        Boolean(scope) && raw?.sessionId === scope,
      inputConsumptions: Array.isArray(raw?.inputConsumptions)
        ? raw.inputConsumptions.map(summarize)
        : null,
      inFlightRun: summarize(raw?.inFlightRun),
      sessionInfo: summarize(raw?.sessionInfo),
      inFlightRunMatches: matches(raw?.inFlightRun),
      receiptsArray: Array.isArray(receipts),
      receipts: Array.isArray(receipts)
        ? receipts.map(summarize)
        : record(receipts)
          ? Object.entries(record(receipts)!).map(([key, value]) => ({
              exactKeyMatches: matches(key),
              ...summarize(value),
            }))
          : null,
      messages: messages.flatMap((value: unknown) => {
        const message = record(value);
        if (!message || !['user', 'assistant'].includes(String(message.role)))
          return [];
        return [
          {
            role: message.role,
            stopReason: [
              'stop',
              'end_turn',
              'toolUse',
              'error',
              'aborted',
              'max_tokens',
            ].includes(String(message.stopReason))
              ? message.stopReason
              : null,
            channel: ['final', 'commentary', 'analysis'].includes(
              String(message.channel),
            )
              ? message.channel
              : null,
            idMatches: matches(message.id),
            stableIdPresent:
              typeof message.id === 'string' && message.id.length > 0,
            positiveSequence:
              typeof message.seq === 'number' && message.seq > 0,
            exactInputText: text(message) === input.text,
            expectedAssistantReply:
              text(message) === 'Real Gateway integration response.',
            runIdMatches: matches(message.runId),
            idempotencyKeyMatches: matches(message.idempotencyKey),
            openclaw: summarize(message.__openclaw),
          },
        ];
      }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    return {
      pendingState: input.state,
      nativeReady: native.ready,
      requestFailed: true,
      errorMentionsInputRunIds: detail.includes('inputRunIds'),
      errorMentionsInvalidParameters: /invalid|parameter/iu.test(detail),
      errorKeys: Object.keys(record(error) ?? {}),
    };
  }
}
