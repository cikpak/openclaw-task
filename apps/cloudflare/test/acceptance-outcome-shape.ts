import { processingEvidence } from './acceptance-processing-shape.js';
import { record } from './acceptance-receipt-shape.js';
const choice = (value: unknown, allowed: string[]) =>
  typeof value === 'string'
    ? allowed.includes(value)
      ? value
      : 'other'
    : 'absent';
export function outcomeShape(
  messages: Record<string, unknown>[],
  receipts: unknown[],
  consumptions: unknown[],
  input: { commandId: string },
  parent: { commandId: string } | null,
  inFlight: unknown,
) {
  const matches = (value: unknown) =>
    value === input.commandId || value === `${input.commandId}:user`;
  const meta = (message: Record<string, unknown>) => record(message.__openclaw);
  const users = messages.filter(
    (message) =>
      message.role === 'user' && matches(meta(message)?.idempotencyKey),
  );
  const sequence = (message: Record<string, unknown>) =>
    Number(meta(message)?.seq);
  const stable = (message: Record<string, unknown>) => {
    const id = meta(message)?.id;
    return (
      typeof id === 'string' && id.length > 0 && !id.startsWith('pending:')
    );
  };
  const linkedEvent = (value: unknown) =>
    users.some((user) => stable(user) && meta(user)?.id === value);
  const processing = processingEvidence(
    messages,
    input.commandId,
    parent?.commandId,
  );
  return {
    ...processing.summary,
    inFlightMatchesProcessingOwner: processing.active(inFlight),
    messages: messages.flatMap((message) =>
      message.role !== 'user' && message.role !== 'assistant'
        ? []
        : [
            {
              role: message.role,
              ...processing.fields(message),
              requestFailed: message.requestFailed === true,
              isError: message.isError === true,
              hasError: Boolean(message.error),
              hasErrorMessage: Boolean(message.errorMessage),
              stableId: stable(message),
              positiveSequence:
                Number.isSafeInteger(sequence(message)) &&
                sequence(message) > 0,
              exactInputKey: matches(meta(message)?.idempotencyKey),
              runMatchesInput: meta(message)?.runId === input.commandId,
              runMatchesParent:
                Boolean(parent) && meta(message)?.runId === parent?.commandId,
              steerTargetPresent:
                typeof meta(message)?.steerTargetRunId === 'string',
              steerTargetMatchesInput:
                meta(message)?.steerTargetRunId === input.commandId,
              steerTargetMatchesParent:
                Boolean(parent) &&
                meta(message)?.steerTargetRunId === parent?.commandId,
              stopReason: choice(message.stopReason, [
                'stop',
                'end_turn',
                'length',
                'toolUse',
                'error',
                'aborted',
                'max_tokens',
              ]),
              channel: choice(message.channel, [
                'final',
                'commentary',
                'analysis',
              ]),
              hasToolCall:
                Array.isArray(message.content) &&
                message.content.some((value: unknown) =>
                  ['toolCall', 'tool_use', 'functionCall'].includes(
                    String(record(value)?.type),
                  ),
                ),
              newerThanLinkedUser: users.some(
                (user) =>
                  Number.isSafeInteger(sequence(user)) &&
                  sequence(message) > sequence(user),
              ),
            },
          ],
    ),
    receipts: receipts.map((value) => {
      const item = record(value);
      return {
        exactInput: item?.runId === input.commandId,
        state: choice(item?.state, ['pending', 'consumed']),
        cancelled: item?.cancelled === true,
        hasConsumedByEvent: typeof item?.consumedByEventId === 'string',
        consumedByLinkedUser: linkedEvent(item?.consumedByEventId),
      };
    }),
    consumptions: consumptions.map((value) => {
      const item = record(value);
      return {
        exactInput: item?.runId === input.commandId,
        hasConsumedByEvent: typeof item?.consumedByEventId === 'string',
        consumedByLinkedUser: linkedEvent(item?.consumedByEventId),
      };
    }),
  };
}
