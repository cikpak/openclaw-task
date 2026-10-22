import type {
  Attachment,
  ChatSettings,
  ConversationCommand,
  PendingMessage,
} from '@messenger/contracts';
import type { Store } from '../storage/store.js';
import type {
  GatewayAttachment,
  GatewayHistory,
  GatewayMapping,
} from '../gateway/types.js';
import {
  ApplicationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../errors.js';

export function requireVersion(
  actual: number,
  expected: string | undefined,
): void {
  if (!expected)
    throw new ApplicationError(
      428,
      'PRECONDITION_REQUIRED',
      'Reload this resource and include its version.',
    );
  if (expected !== `"${actual}"`)
    throw new ApplicationError(
      412,
      'STALE_VERSION',
      'This resource changed. Reload before saving.',
    );
}

export function requireContent(text: string, uploads?: string[]): void {
  if (!text.trim() && !uploads?.length)
    throw new ValidationError(
      'Write a message or attach a supported file before sending.',
    );
}
export interface MessageMedia {
  prepare(
    settings: ChatSettings,
    ids: string[],
    target?: GatewayMapping,
  ): Promise<Attachment[]>;
  payload(
    attachments: Attachment[],
    settings: ChatSettings,
    target: GatewayMapping,
  ): Promise<GatewayAttachment[]>;
}

export function enqueue(
  store: Store,
  command: Extract<ConversationCommand, { type: 'conversation.message.send' }>,
  attachments: Attachment[] = [],
): PendingMessage {
  requireContent(
    command.text,
    attachments.map((attachment) => attachment.uploadId),
  );
  return store.db.transaction(() => {
    const items = store.pending(command.chatId);
    if (items.filter((item) => item.state === 'pending').length >= 20)
      throw new ConflictError(
        'QUEUE_FULL',
        'This chat has twenty queued messages. Wait or cancel one before sending.',
      );
    const item: PendingMessage = {
      id: command.commandId,
      chatId: command.chatId,
      position: (items.at(-1)?.position ?? 0) + 1,
      text: command.text,
      attachments,
      revision: 1,
      state: 'pending',
      submissionId: command.commandId,
      createdAt: Date.now(),
    };
    store.savePending(item);
    store.saveCommandRequest(command.commandId, JSON.stringify(command));
    store.saveCommand({
      type: 'command.result',
      commandId: command.commandId,
      ok: true,
      data: { messageId: item.id },
    });
    return item;
  })();
}

export function editable(
  store: Store,
  chatId: string,
  messageId: string,
  revision: number,
): PendingMessage {
  const item = store
    .pending(chatId)
    .find((candidate) => candidate.id === messageId);
  if (!item) throw new NotFoundError();
  if (item.state !== 'pending')
    throw new ConflictError(
      'MESSAGE_CLAIMED',
      'This message is already being submitted and cannot be edited.',
    );
  if (item.revision !== revision)
    throw new ConflictError(
      'STALE_MESSAGE',
      'This queued message changed. Reload it before continuing.',
    );
  return item;
}

/** Receipts, rather than missing history text, decide whether an input can leave recovery. */
export function reconcileInputs(
  store: Store,
  chatId: string,
  history: GatewayHistory,
): void {
  for (const item of store.pending(chatId)) {
    if (item.state === 'pending') continue;
    const receipt = history.receipts.find(
      (candidate) => candidate.runId === item.submissionId,
    );
    if (receipt?.cancelled || receipt?.state === 'consumed') {
      store.removePending(
        item.id,
        receipt.cancelled ? 'cancelled' : 'consumed',
      );
    } else if (
      receipt?.state === 'pending' ||
      history.activeRun?.id === item.submissionId
    ) {
      item.state = 'submitted';
      store.savePending(item);
    } else if (item.state === 'submitting' || item.state === 'submitted') {
      item.state = 'unknown';
      store.savePending(item);
    }
  }
}

export function hasWork(
  store: Store,
  chatId: string,
  active: boolean,
): boolean {
  return (
    active || store.pending(chatId).some((item) => item.state !== 'cancelled')
  );
}
