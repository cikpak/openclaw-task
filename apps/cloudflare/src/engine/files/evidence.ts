import type { GatewayMapping } from '../../../../backend/src/gateway/types.js';
import type { AuthStorage } from '../gateway/identity.js';
export interface PublicationEvidence {
  mapping: GatewayMapping;
  path: string;
  name: string;
}
/** Private start/result correlation survives manager recreation without storing raw tool payloads. */
export class FileEvidence {
  private readonly cache = new Map<string, PublicationEvidence>();
  constructor(
    private readonly storage?: Pick<AuthStorage, 'get' | 'put' | 'delete'>,
  ) {}
  private async key(identity: string): Promise<string> {
    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(identity),
    );
    return `publication-evidence:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  async remember(identity: string, record: PublicationEvidence): Promise<void> {
    if (this.storage) await this.storage.put(await this.key(identity), record);
    this.cache.set(identity, record);
  }
  async get(identity: string): Promise<PublicationEvidence | undefined> {
    return (
      this.cache.get(identity) ??
      (this.storage
        ? await this.storage.get<PublicationEvidence>(await this.key(identity))
        : undefined)
    );
  }
  async forget(identity: string): Promise<void> {
    if (this.storage) await this.storage.delete(await this.key(identity));
    this.cache.delete(identity);
  }
}
