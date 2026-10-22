import type {
  GatewayAttachment,
  GatewayMapping,
  GatewayHistory,
} from '../../../../backend/src/gateway/types.js';
import type { AuthStorage } from '../gateway/identity.js';
import type { Attachment } from '@messenger/contracts';
/** Private helper paths become native input, while the exact generated suffix stays out of UI history. */
export class NativeAttachments {
  private tail = Promise.resolve();
  constructor(private readonly storage: AuthStorage) {}
  async prepare(
    mapping: GatewayMapping,
    id: string,
    text: string,
    attachments: GatewayAttachment[],
  ) {
    const local = attachments.filter((file) => file.nativePath);
    if (!local.length) return { text, attachments };
    for (const file of local) {
      const root =
        file.nativePath?.slice(0, file.nativePath.lastIndexOf('/') + 1) ?? '';
      if (
        !file.nativePath?.startsWith('/recovery/') ||
        !file.nativePath.includes('/documents/.messenger-inputs/') ||
        file.content ||
        (file.nativeReadFiles &&
          (file.mimeType !== 'application/pdf' ||
            !file.nativeReadFiles.length ||
            file.nativeReadFiles.length > 5 ||
            file.nativeReadFiles.some((item) => {
              const relative = item.path.startsWith(root)
                ? item.path.slice(root.length)
                : '';
              return (
                !/^\.pdf-read-[a-f0-9]{64}\/(?:extracted-text\.txt|page-[1-4]\.png)$/.test(
                  relative,
                ) || !['image/png', 'text/plain'].includes(item.mimeType)
              );
            })))
      )
        throw new Error('Invalid private attachment');
    }
    const key = `attachment-appendix:${mapping.sessionKey}:${id}`;
    let suffix = '';
    const operation = this.tail.then(async () => {
      const existing = await this.storage.get<{
        suffix: string;
        marker: string;
        attachments?: Attachment[];
      }>(key);
      const marker = existing?.marker ?? crypto.randomUUID();
      suffix =
        existing?.suffix ??
        `\n\n[messenger-attachments:${marker}]\nThe user attached these files for this conversation. Use the read tool to inspect them (including images) before answering. Do not expose local paths or internal companion names.\n${local
          .map((file) => file.nativeReadNote ?? '')
          .filter(Boolean)
          .join(
            '\n',
          )}\n${local.flatMap((file) => (file.nativeReadFiles?.length ? file.nativeReadFiles.map((item) => JSON.stringify({ name: `${file.fileName} (${item.mimeType === 'text/plain' ? 'document text' : 'document page image'})`, mimeType: item.mimeType, path: item.path })) : [JSON.stringify({ name: file.fileName, mimeType: file.mimeType, path: file.nativePath })])).join('\n')}\n[/messenger-attachments]`;
      const publicAttachments = existing
        ? (existing.attachments ?? [])
        : local.flatMap((file) =>
            file.originalAttachment
              ? [
                  {
                    uploadId: file.originalAttachment.uploadId,
                    name: file.originalAttachment.name,
                    mimeType: file.originalAttachment.mimeType,
                    size: file.originalAttachment.size,
                  },
                ]
              : [],
          );
      const record = {
        suffix,
        marker,
        submissionId: id,
        attachments: publicAttachments,
      };
      await this.storage.put(key, record);
      await this.storage.put(
        `attachment-marker:${mapping.sessionKey}:${marker}`,
        record,
      );
    });
    this.tail = operation.catch(() => {});
    await operation;
    return {
      text: text + suffix,
      attachments: attachments.filter((file) => !file.nativePath),
    };
  }
  async history(
    mapping: GatewayMapping,
    history: GatewayHistory,
  ): Promise<GatewayHistory> {
    const messages = [];
    for (const message of history.messages) {
      const match =
        message.role === 'user'
          ? /\n\n\[messenger-attachments:([a-f0-9-]{36})\]/.exec(message.text)
          : null;
      const record = match
        ? await this.storage.get<{
            suffix: string;
            submissionId: string;
            attachments?: Attachment[];
          }>(`attachment-marker:${mapping.sessionKey}:${match[1]}`)
        : undefined;
      messages.push(
        record &&
          (!message.runId || message.runId === record.submissionId) &&
          message.text.endsWith(record.suffix)
          ? {
              ...message,
              text: message.text.slice(0, -record.suffix.length),
              ...(record.attachments?.length
                ? { attachments: record.attachments }
                : {}),
            }
          : message,
      );
    }
    return { ...history, messages };
  }
}
