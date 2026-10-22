import type { Message } from '@messenger/contracts';
import type { GatewayContext } from './context.js';
import type { GatewayMapping, GatewayHistory, GatewayEvent } from './types.js';
import { GatewayUnavailableError, ValidationError } from '../errors.js';
import { canonicalModel, projectMessage, messageText } from './messages.js';
import { historySchema } from './protocol-schemas.js';
import { completeMessages } from './complete-messages.js';
import { projectTranscriptTools, projectToolEvent } from './tools.js';
export class HistoryOperations {
  constructor(private readonly context: GatewayContext) {}
  async history(
    mapping: GatewayMapping,
    options: { cursor?: string; inputRunIds?: string[] } = {},
  ): Promise<GatewayHistory> {
    const generation = this.context.capabilityGeneration;
    // Gateway cursors catch up forwards; older pages use the authoritative nextOffset.
    let offset = options.cursor
      ? Number(/^older:(\d+)$/.exec(options.cursor)?.[1])
      : undefined;
    let anchorTotal: number | undefined;
    const before = options.cursor
      ? /^before:(\d+)$/.exec(options.cursor)
      : null;
    if (before) {
      const sequence = Number(before[1]);
      const head = historySchema.parse(
        await this.context.request('chat.history', {
          sessionKey: mapping.sessionKey,
          agentId: mapping.agentId,
          limit: 1,
          maxBytes: 262144,
        }),
      );
      if (
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        head.totalMessages === undefined ||
        head.totalMessages < sequence
      )
        throw new ValidationError(
          'The conversation history changed. Refresh this chat before loading earlier messages.',
        );
      anchorTotal = head.totalMessages;
      offset = head.totalMessages - sequence + 1;
    }
    if (options.cursor && (!Number.isSafeInteger(offset) || (offset ?? 0) < 1))
      throw new ValidationError(
        'The history page is invalid. Refresh this chat.',
      );
    const data = historySchema.parse(
      await this.context.request('chat.history', {
        sessionKey: mapping.sessionKey,
        agentId: mapping.agentId,
        limit: 50,
        maxBytes: 262144,
        ...(offset === undefined ? {} : { offset }),
        ...(options.inputRunIds?.length
          ? { inputRunIds: options.inputRunIds }
          : {}),
      }),
    );
    if (anchorTotal !== undefined && data.totalMessages !== anchorTotal)
      throw new ValidationError(
        'The conversation history changed while loading. Try loading earlier messages again.',
      );
    data.messages = await completeMessages(
      this.context,
      mapping,
      data.messages,
    );
    const entry = data.sessionInfo;
    const known = this.context.knownSettings.get(mapping.sessionKey);
    const model =
      entry?.model && entry.modelProvider
        ? canonicalModel(entry.modelProvider, entry.model)
        : known?.model;
    if (!model) throw new GatewayUnavailableError();
    const settings = {
      model,
      thinkingLevel:
        data.thinkingLevel ??
        entry?.thinkingLevel ??
        known?.thinkingLevel ??
        'off',
      fastMode: (data.fastMode ?? entry?.fastMode) === true,
      ...(await this.context.instructions.read(mapping)),
    };
    if (generation === this.context.capabilityGeneration)
      this.context.knownSettings.set(mapping.sessionKey, settings);
    const run = data.inFlightRun;
    return {
      ...((data.sessionId ?? entry?.sessionId)
        ? { sessionId: data.sessionId ?? entry?.sessionId }
        : {}),
      messages: data.messages
        .map(projectMessage)
        .filter((m): m is Message => m !== null),
      activeRun: run
        ? {
            id: run.runId,
            text: run.text ?? messageText(run.message),
            sequence: run.seq ?? 0,
          }
        : null,
      historyCursor:
        data.hasMore && data.nextOffset !== undefined
          ? `older:${data.nextOffset}`
          : null,
      hasOlderHistory: data.hasMore ?? data.messages.length >= 50,
      settings,
      tools: [
        ...projectTranscriptTools(data.messages),
        ...(run?.events ?? [])
          .map(projectToolEvent)
          .filter(
            (event): event is Extract<GatewayEvent, { type: 'tool' }> =>
              event !== null && event.sessionKey === mapping.sessionKey,
          )
          .map((event) => event.tool),
      ].slice(-100),
      receipts: data.inputReceipts ?? [],
    };
  }
}
