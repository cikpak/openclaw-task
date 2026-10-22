import type {
  ConversationCommand,
  ConversationResult,
} from '@messenger/contracts';
import { ConflictError, toProblem } from '../errors.js';
import { executeCommand } from './commands.js';

import {
  autoTitle,
  pending as readPending,
  preferences,
  prepareMessage,
} from './service-catalog.js';
import { schedule, startSteer } from './service-dispatch.js';
import { projectHistory, snapshot } from './service-history.js';
import { changed, withLock } from './service-runtime.js';
import type { ServiceState } from './service-state.js';
import {
  claimSubmission,
  locallyUninvoked,
  invalidateChatSubmissions,
} from './submission-claims.js';
export async function runCommand(
  ctx: ServiceState,
  command: ConversationCommand,
): Promise<ConversationResult> {
  return withLock(ctx, `command:${command.commandId}`, async () => {
    const request = JSON.stringify(command);
    const previous = ctx.store.commandRequest(command.commandId);
    if (previous && previous !== request)
      return failure(
        ctx,
        command.commandId,
        new ConflictError(
          'COMMAND_ID_REUSED',
          'This command identity was already used with different values.',
        ),
      );
    // Snapshots and history are repeatable observations, not durable mutation receipts.
    // message.read changes unread state and keeps the normal mutation identity protection.
    if (
      command.type === 'conversation.snapshot.request' ||
      command.type === 'conversation.history.request'
    ) {
      try {
        return {
          type: 'command.result',
          commandId: command.commandId,
          ok: true,
          data: await withLock(ctx, command.chatId ?? 'snapshots', () =>
            execute(ctx, command),
          ),
        };
      } catch (error) {
        return failure(ctx, command.commandId, error);
      }
    }
    const stored = ctx.store.getCommand(command.commandId);
    if (stored) return stored;
    if (previous) {
      const pending =
        'chatId' in command && command.chatId
          ? readPending(ctx, command.chatId).find(
              (item) => item.id === command.commandId,
            )
          : undefined;
      if (pending)
        return {
          type: 'command.result',
          commandId: command.commandId,
          ok: true,
          data: { messageId: pending.id },
        };
      return failure(
        ctx,
        command.commandId,
        new ConflictError(
          'COMMAND_OUTCOME_UNKNOWN',
          'The earlier command outcome is uncertain. Refresh this chat before continuing.',
        ),
      );
    }
    ctx.store.saveCommandRequest(command.commandId, request);
    let result: ConversationResult;
    try {
      result = {
        type: 'command.result',
        commandId: command.commandId,
        ok: true,
        data: await withLock(
          ctx,
          'chatId' in command && command.chatId ? command.chatId : 'snapshots',
          () => execute(ctx, command),
        ),
      };
    } catch (error) {
      result = failure(ctx, command.commandId, error);
    }
    ctx.store.saveCommand(result);
    if (result.ok && 'chatId' in command && command.chatId)
      schedule(ctx, command.chatId);
    return result;
  });
}
export function failure(
  ctx: ServiceState,
  commandId: string,
  error: unknown,
): ConversationResult {
  return {
    type: 'command.result',
    commandId,
    ok: false,
    error: toProblem(error, crypto.randomUUID()),
  };
}
export function execute(
  ctx: ServiceState,
  command: ConversationCommand,
): Promise<
  Extract<
    ConversationResult,
    {
      ok: true;
    }
  >['data']
> {
  return executeCommand(
    {
      store: ctx.store,
      gateway: ctx.gateway,
      streams: ctx.streams,
      snapshot: (id) => snapshot(ctx, id),
      pending: (id) => readPending(ctx, id),
      claimSubmission: (item) => claimSubmission(ctx, item),
      locallyUninvoked: (item) => locallyUninvoked(ctx, item),
      invalidateUninvoked: (id) => invalidateChatSubmissions(ctx, id),
      projectHistory: (id, history) => projectHistory(ctx, id, history),
      preferences: () => preferences(ctx),
      changed: (id, affectsExecution) => changed(ctx, id, affectsExecution),
      autoTitle: (id, text) => autoTitle(ctx, id, text),
      startSteer: (id, item) => startSteer(ctx, id, item),
      prepareMessage: (settings, ids, chatId) =>
        prepareMessage(ctx, settings, ids, chatId),
    },
    command,
  );
}
