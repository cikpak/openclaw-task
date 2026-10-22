import type {
  GatewayAttachment,
  GatewayMapping,
  GatewayHistory,
} from '../../../../backend/src/gateway/types.js';
import type { AuthStorage } from '../gateway/identity.js';
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
      if (
        !file.nativePath?.startsWith('/recovery/') ||
        !file.nativePath.includes('/documents/.messenger-inputs/') ||
        file.content
      )
        throw new Error('Invalid private attachment');
    }
    const key = `attachment-appendix:${mapping.sessionKey}:${id}`;
    let suffix = '';
    const operation = this.tail.then(async () => {
      const existing = await this.storage.get<{
        suffix: string;
        marker: string;
      }>(key);
      const marker = existing?.marker ?? crypto.randomUUID();
      suffix =
        existing?.suffix ??
        `\n\n[messenger-attachments:${marker}]\nThe user attached these files for this conversation. Use the read tool to inspect them (including images) before answering. Do not expose local paths.\n${local.map((file) => JSON.stringify({ name: file.fileName, mimeType: file.mimeType, path: file.nativePath })).join('\n')}\n[/messenger-attachments]`;
      const record = { suffix, marker, submissionId: id };
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
        ? await this.storage.get<{ suffix: string; submissionId: string }>(
            `attachment-marker:${mapping.sessionKey}:${match[1]}`,
          )
        : undefined;
      messages.push(
        record &&
          (!message.runId || message.runId === record.submissionId) &&
          message.text.endsWith(record.suffix)
          ? { ...message, text: message.text.slice(0, -record.suffix.length) }
          : message,
      );
    }
    return { ...history, messages };
  }
}
