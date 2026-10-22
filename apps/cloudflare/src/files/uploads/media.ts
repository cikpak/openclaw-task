import type { Attachment, ChatSettings } from '@messenger/contracts';
import type {
  Gateway,
  GatewayAttachment,
  GatewayMapping,
} from '../../../../backend/src/gateway/types.js';
import type { MessageMedia } from '../../../../backend/src/chats/queue.js';
import { ApplicationError } from '../../../../backend/src/errors.js';
import { validateMessageSize } from '../../../../backend/src/uploads/validation.js';
import type { UploadService } from './service.js';
import type { UploadHandoff, UploadRecord } from './types.js';
export class UploadMedia implements MessageMedia {
  private handoff: UploadHandoff | undefined;
  constructor(
    private readonly uploads: UploadService,
    private readonly gateway: Gateway,
  ) {}
  setHandoff(handoff: UploadHandoff): void {
    this.handoff = handoff;
  }
  private compatible(
    rows: UploadRecord[],
    settings: ChatSettings,
    catalog: Awaited<ReturnType<Gateway['models']>>,
  ): void {
    const model = catalog.find(
      (entry) => entry.id === settings.model && entry.available,
    );
    if (
      !model ||
      rows.some(
        (row) =>
          !model.input.includes(
            row.mimeType.startsWith('image/') ? 'image' : 'text',
          ),
      )
    )
      throw new ApplicationError(
        422,
        'ATTACHMENT_MODEL_INCOMPATIBLE',
        'The selected model cannot consume these attachments. Choose a compatible model or remove the files.',
      );
  }
  prepare(
    settings: ChatSettings,
    ids: string[],
    mapping?: GatewayMapping,
  ): Promise<Attachment[]> {
    const chat = mapping
      ? this.uploads.context.store
          .listChats()
          .find(
            (chat) =>
              chat.agentId === mapping.agentId &&
              chat.sessionKey === mapping.sessionKey,
          )
      : undefined;
    const attachments = this.uploads.prepareIds(ids, undefined, chat?.id);
    const catalog = mapping ? this.gateway.cachedModels?.(mapping) : null;
    if (catalog)
      this.compatible(
        ids.map((id) => this.uploads.database.get(id, undefined, true)),
        settings,
        catalog,
      );
    // With no verified offline catalog, validation is deferred to dispatch, never a staging wake.
    return Promise.resolve(attachments);
  }
  async payload(
    attachments: Attachment[],
    settings: ChatSettings,
    mapping: GatewayMapping,
  ): Promise<GatewayAttachment[]> {
    if (!attachments.length) return [];
    const chat = this.uploads.context.store
      .listChats()
      .find(
        (chat) =>
          chat.agentId === mapping.agentId &&
          chat.sessionKey === mapping.sessionKey,
      );
    if (!chat)
      throw new ApplicationError(
        410,
        'UPLOAD_UNAVAILABLE',
        'An attachment is unavailable. Attach it again before retrying.',
      );
    const rows = attachments.map((item) => {
      const row = this.uploads.database.get(item.uploadId, undefined, true);
      if (
        row.chatId !== chat.id ||
        row.name !== item.name ||
        row.mimeType !== item.mimeType ||
        row.size !== item.size
      )
        throw new ApplicationError(
          410,
          'UPLOAD_UNAVAILABLE',
          'An attachment is unavailable. Attach it again before retrying.',
        );
      return row;
    });
    this.compatible(rows, settings, await this.gateway.models(mapping));
    validateMessageSize(rows.map((row) => row.size));
    if (!this.handoff) throw new Error('Attachment delivery unavailable');
    const grants = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        url: await this.uploads.objects.signedGet(row),
      })),
    );
    return this.handoff(mapping, grants);
  }
}
