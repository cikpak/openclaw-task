import type {
  ActiveRun,
  Message,
  PendingMessage,
  SettledRun,
} from '@messenger/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../database.js';
import { pendingSchema } from '../schemas.js';
export const STREAM_PREVIEW_LIMIT = 256 * 1024;
/** Retain content fingerprints, not canonical bodies or mutable observation metadata. */
function contentFingerprint(message: Message): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        message.role,
        message.text,
        message.attachments ?? [],
        message.artifacts ?? [],
      ]),
    )
    .digest('hex');
}
/** Terminal text is presentation only, never executable or canonical. */
export class SettledRunProjection {
  private readonly runs = new Map<
    string,
    { run: SettledRun; known: Map<string, string> }
  >();
  capture(
    id: string,
    run: ActiveRun | undefined,
    state: SettledRun['state'],
    messages: Message[],
  ): void {
    if (!run?.text) return;
    this.runs.set(id, {
      run: { ...run, state },
      known: new Map(
        messages.map((message) => [message.id, contentFingerprint(message)]),
      ),
    });
    if (this.runs.size > 10)
      this.runs.delete(this.runs.keys().next().value ?? '');
  }
  get(id: string): SettledRun | undefined {
    return this.runs.get(id)?.run;
  }
  reconcile(
    id: string,
    messages: Message[],
    activeRun: ActiveRun | null,
  ): void {
    const entry = this.runs.get(id);
    if (!entry) return;
    if (activeRun && activeRun.id !== entry.run.id) this.discard(id);
    else if (
      messages.some(
        (message) =>
          message.role === 'assistant' &&
          ((message.runId === entry.run.id &&
            (!entry.known.has(message.id) ||
              entry.known.get(message.id) !== contentFingerprint(message) ||
              message.text === entry.run.text ||
              (entry.run.truncated === true &&
                message.text.startsWith(entry.run.text)))) ||
            (!message.runId && !entry.known.has(message.id))),
      )
    )
      this.discard(id);
  }
  discard(id: string): void {
    this.runs.delete(id);
  }
  clear(): void {
    this.runs.clear();
  }
}
const acceptedWindow = 21;
const unsentWindow = 20;
/** These limits affect display only. Pending persistence and upstream execution retain full content. */
export function boundedPending(
  store: Store,
  chatId: string,
): { pending: PendingMessage[]; hiddenPendingCount: number } {
  const decode = (row: unknown): PendingMessage =>
    pendingSchema.parse(
      JSON.parse(z.object({ json: z.string() }).parse(row).json),
    );
  const unsent = store.db
    .prepare(
      "SELECT json FROM pending_messages WHERE chat_id = ? AND json_extract(json, '$.state') = 'pending' ORDER BY position LIMIT ?",
    )
    .all(chatId, unsentWindow)
    .map(decode);
  const accepted = store.db
    .prepare(
      "SELECT json FROM pending_messages WHERE chat_id = ? AND json_extract(json, '$.state') != 'pending' ORDER BY position LIMIT ?",
    )
    .all(chatId, acceptedWindow)
    .map(decode);
  const total = z
    .object({ count: z.number().int().nonnegative() })
    .parse(
      store.db
        .prepare(
          'SELECT count(*) AS count FROM pending_messages WHERE chat_id = ?',
        )
        .get(chatId),
    ).count;
  return {
    pending: [...unsent, ...accepted].sort((a, b) => a.position - b.position),
    hiddenPendingCount: total - unsent.length - accepted.length,
  };
}
export function boundedRun(run: ActiveRun | null): ActiveRun | null {
  if (!run) return null;
  return {
    ...run,
    text: run.text.slice(0, STREAM_PREVIEW_LIMIT),
    truncated: run.truncated === true || run.text.length > STREAM_PREVIEW_LIMIT,
  };
}
export function appendPreview(
  old: ActiveRun | undefined,
  id: string,
  text: string,
  replace: boolean,
  sequence: number,
): ActiveRun {
  if (replace)
    return {
      id,
      text: text.slice(0, STREAM_PREVIEW_LIMIT),
      sequence,
      truncated: text.length > STREAM_PREVIEW_LIMIT,
    };
  if (old?.truncated) return { ...old, sequence };
  const prefix = old?.text ?? '';
  const remaining = Math.max(0, STREAM_PREVIEW_LIMIT - prefix.length);
  return {
    id,
    text: prefix + text.slice(0, remaining),
    sequence,
    truncated: text.length > remaining,
  };
}
