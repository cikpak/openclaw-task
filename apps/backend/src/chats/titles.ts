import type { Store } from '../storage/store.js';
import type { Gateway } from '../gateway/types.js';
import { mapping } from './service-record.js';
/** Own-agent title calls are optional and cannot override a later manual rename. */
export class TitleCoordinator {
  private closed = false;
  private readonly jobs = new Set<Promise<void>>();
  constructor(
    private readonly store: Store,
    private readonly gateway: Gateway,
    private readonly changed: (id: string) => void,
    private readonly lock: <T>(
      id: string,
      work: () => Promise<T>,
    ) => Promise<T>,
  ) {}
  close(): void {
    this.closed = true;
  }
  async drain(): Promise<void> {
    await Promise.all(this.jobs);
  }
  name(id: string, text: string): void {
    const chat = this.store.getChat(id);
    const metadata = this.store.metadata(id);
    if (metadata.manualName) return;
    if (chat.name === 'New chat' && !metadata.titleText) {
      const fallback = text.trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!fallback) return;
      chat.name = fallback;
      chat.version += 1;
      metadata.titleText = text;
      metadata.titleFallback = fallback;
      this.store.saveChat(chat);
      this.store.saveMetadata(id, metadata);
    }
    if (
      metadata.titleRequested ||
      !metadata.titleText ||
      chat.name !== metadata.titleFallback ||
      !this.gateway.ready ||
      !chat.agentId ||
      !chat.sessionKey ||
      !this.gateway.title
    )
      return;
    metadata.titleRequested = true;
    this.store.saveMetadata(id, metadata);
    const job = this.gateway
      .title(mapping(chat), chat.settings.model, metadata.titleText)
      .then(async (title) => {
        if (this.closed || !title?.trim()) return;
        await this.lock(id, () => {
          if (this.closed) return Promise.resolve();
          const current = this.store.getChat(id);
          const latest = this.store.metadata(id);
          if (
            latest.manualName ||
            current.name !== metadata.titleFallback ||
            current.status === 'deleting'
          )
            return Promise.resolve();
          current.name = title.trim().slice(0, 100);
          current.version += 1;
          this.store.saveChat(current);
          this.changed(id);
          return Promise.resolve();
        });
      })
      .catch(() => {
        /* The persisted deterministic fallback remains useful if title generation is unavailable. */
      })
      .finally(() => {
        this.jobs.delete(job);
      });
    this.jobs.add(job);
  }
}
