import { FileEvidence } from './evidence.js';
import type { AuthStorage } from '../gateway/identity.js';
import type { BrowserFile, BrowserToolSummary } from '@messenger/contracts';
import type { GatewayMapping } from '../../../../backend/src/gateway/types.js';
import {
  BrowserProjection,
  type ProjectionPolicy,
} from '../../../../backend/src/presentation/safe.js';
export interface EngineFilePublication extends GatewayMapping {
  path: string;
  documentsRoot: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedAt: number;
  digest?: string;
}
export interface EngineUpload {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  key: string;
  url: string;
}
export interface NativePrivateFrame {
  event: string;
  payload?: unknown;
}
interface Options {
  storage?: Pick<AuthStorage, 'get' | 'put' | 'delete'> | undefined;
  helper(path: string, init?: RequestInit): Promise<Response>;
  catalog: {
    publish(input: EngineFilePublication): Promise<BrowserFile>;
    policy(): ProjectionPolicy;
    records(): (GatewayMapping & { path: string })[];
    revoke(mapping: GatewayMapping, path: string): Promise<void>;
  };
  secrets?: (() => readonly string[] | Promise<readonly string[]>) | undefined;
  summary?:
    | ((mapping: GatewayMapping, summary: BrowserToolSummary) => void)
    | undefined;
  mapping(sessionKey: string): GatewayMapping | null;
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
/** Raw native evidence and paths remain private to this adapter and the durable catalog. */
export class EngineFiles {
  private readonly evidence: FileEvidence;
  private active = 0;
  busy(): boolean {
    return this.active > 0;
  }
  constructor(private readonly options: Options) {
    this.evidence = new FileEvidence(options.storage);
  }
  policy(): ProjectionPolicy {
    return this.options.catalog.policy();
  }
  private async json<T>(path: string, data: unknown): Promise<T> {
    this.active++;
    try {
      const response = await this.options.helper(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(data as object),
          secrets: (await this.options.secrets?.()) ?? [],
        }),
        signal: AbortSignal.timeout(path === '/files/handoff' ? 120000 : 30000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('File unavailable');
      }
      return await response.json<T>();
    } finally {
      this.active--;
    }
  }
  metadata(
    mapping: GatewayMapping,
    path: string,
  ): Promise<
    Omit<EngineFilePublication, keyof GatewayMapping> & { digest: string }
  > {
    return this.json('/files/metadata', { ...mapping, path });
  }
  inputMetadata(
    mapping: GatewayMapping,
    id: string,
  ): Promise<{
    digest: string;
    size: number;
    modifiedAt: number;
    path: string;
    name: string;
    mimeType: string;
  }> {
    return this.json('/files/input-metadata', { ...mapping, id });
  }
  private async admitted(path: string, data: object): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      return await this.options.helper(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...data,
          secrets: (await this.options.secrets?.()) ?? [],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  read(mapping: GatewayMapping, path: string): Promise<Response> {
    return this.admitted('/files/read', { ...mapping, path });
  }
  readInput(mapping: GatewayMapping, id: string): Promise<Response> {
    return this.admitted('/files/input', { ...mapping, id });
  }
  handoff(data: GatewayMapping & { uploads: EngineUpload[] }): Promise<{
    uploads: {
      id: string;
      path: string;
      name: string;
      mimeType: string;
      readFiles?: { path: string; name: string; mimeType: string }[];
    }[];
  }> {
    return this.json('/files/handoff', data);
  }
  async audit(): Promise<void> {
    this.active++;
    try {
      for (const record of this.options.catalog.records()) {
        await this.options.catalog.revoke(record, record.path);
        try {
          await this.options.catalog.publish({
            ...record,
            ...(await this.metadata(record, record.path)),
          });
        } catch {
          /* Deleted/private files remain revoked without exposing raw details. */
        }
      }
    } finally {
      this.active--;
    }
  }
  async observe(frame: NativePrivateFrame): Promise<void> {
    this.active++;
    try {
      await this.observeFrame(frame);
    } finally {
      this.active--;
    }
  }
  private async observeFrame(frame: NativePrivateFrame): Promise<void> {
    if (frame.event !== 'agent') return;
    const payload = record(frame.payload),
      data = record(payload?.data);
    if (
      !payload ||
      payload.stream !== 'tool' ||
      !data ||
      typeof payload.sessionKey !== 'string' ||
      typeof payload.runId !== 'string' ||
      typeof data.toolCallId !== 'string'
    )
      return;
    const mapping = this.options.mapping(payload.sessionKey);
    if (!mapping) return;
    const key = `${payload.sessionKey}\0${payload.runId}\0${data.toolCallId}`;
    if (data.phase === 'start') {
      if (!['write', 'edit'].includes(String(data.name))) return;
      const args = record(data.args),
        path = args?.path ?? args?.file_path;
      if (typeof path !== 'string' || path.length > 8192) return;
      await this.evidence.remember(key, {
        mapping,
        path,
        name: String(data.name),
      });
      return;
    }
    if (data.phase !== 'result') return;
    const write = await this.evidence.get(key);
    if (!write) return;
    try {
      if (
        data.isError !== false ||
        data.name !== write.name ||
        write.mapping.agentId !== mapping.agentId ||
        write.mapping.sessionKey !== mapping.sessionKey
      )
        return;
      // A successful native write/edit is explicit classification evidence. Location alone is insufficient.
      // Helper failure (private path, removed file, unknown agent) grants nothing and exposes nothing.
      await this.options.catalog.revoke(mapping, write.path);
      try {
        const metadata = await this.metadata(mapping, write.path);
        await this.options.catalog.publish({ ...mapping, ...metadata });
        const summary = new BrowserProjection(this.policy()).tool({
          id: `${payload.runId}:${data.toolCallId}`,
          operation: write.name as 'write' | 'edit',
          status: 'completed',
          nativePath: metadata.path,
        });
        if (summary) this.options.summary?.(mapping, summary);
      } catch {
        /* Fail closed, keep raw operation and private file activity out of browser state. */
      }
    } finally {
      await this.evidence.forget(key);
    }
  }
}
