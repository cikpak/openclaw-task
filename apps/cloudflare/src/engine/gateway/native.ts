import { GatewayFacade } from '../../../../backend/src/gateway/facade.js';
import type {
  GatewayContext,
  GatewayFiles,
} from '../../../../backend/src/gateway/context.js';
import type { GatewayMapping } from '../../../../backend/src/gateway/types.js';
import type { ProjectionPolicy } from '../../../../backend/src/presentation/safe.js';
import { NotFoundError } from '../../../../backend/src/errors.js';
import {
  NativeGatewayTransport,
  type NativeTransportOptions,
} from './transport.js';
import { SafeGatewayProjection } from './safe-projection.js';
export type { AuthStorage, ExpectedIdentity } from './identity.js';
export interface NativeGatewayOptions extends NativeTransportOptions {
  publicationPolicy?: (() => ProjectionPolicy) | undefined;
  files?: GatewayFiles | undefined;
  fullMessage?: GatewayContext['fullMessage'];
}
const noFiles: GatewayFiles = {
  list: () => Promise.resolve([]),
  handles: () => false,
  download: () => Promise.reject(new NotFoundError()),
  sourcePath: () => {
    throw new NotFoundError();
  },
};
/** Official SDK browser entry is used server-side over the private container Fetcher. */
export class NativeGateway extends GatewayFacade {
  private readonly native: NativeGatewayTransport;
  private readonly safe: SafeGatewayProjection;
  constructor(options: NativeGatewayOptions) {
    const safe = new SafeGatewayProjection(() => {
      const policy = options.publicationPolicy?.() ?? {
        documentsRoots: [],
        publications: [],
      };
      return {
        ...policy,
        secrets: [...(policy.secrets ?? []), ...transport.secrets()],
      };
    });
    const transport = new NativeGatewayTransport(options, (event) => {
      if (event.type === 'connection' && !event.ready) this.blocked = true;
      const projected = safe.event(event);
      if (projected)
        this.emit(
          projected.type === 'connection'
            ? { ...projected, ready: projected.ready && !this.blocked }
            : projected,
        );
    });
    super(transport, options.files ?? noFiles, options.fullMessage);
    this.native = transport;
    this.safe = safe;
    this.optionsFiles = options.files;
  }
  private blocked = true;
  override get ready() {
    return !this.blocked && this.native.ready;
  }
  override set ready(value: boolean) {
    this.native.ready = value;
  }
  dispatch(enabled: boolean): void {
    this.blocked = !enabled;
    this.emit({ type: 'connection', ready: this.ready });
  }
  override stop(): Promise<void> {
    this.dispatch(false);
    return super.stop();
  }
  identity() {
    return this.native.identity();
  }
  waitReady(timeoutMs?: number) {
    return this.native.waitReady(timeoutMs);
  }
  override async history(
    mapping: GatewayMapping,
    options: { cursor?: string; inputRunIds?: string[] } = {},
  ) {
    return this.safe.history(await super.history(mapping, options));
  }
  // Browser file transfer is provided only by the authenticated helper publication layer.
  override async artifacts(mapping: GatewayMapping) {
    return await (this.optionsFiles?.list(mapping) ?? Promise.resolve([]));
  }
  override async artifact(mapping: GatewayMapping, id: string) {
    if (!this.optionsFiles || !this.optionsFiles.handles(id))
      throw new NotFoundError();
    return this.optionsFiles.download(mapping, id);
  }
  override async resolveArtifact(mapping: GatewayMapping, path: string) {
    if (!this.optionsFiles) throw new NotFoundError();
    const sourcePath = this.optionsFiles.sourcePath(mapping, path);
    const found = (await this.optionsFiles.list(mapping)).find(
      (file) => file.sourcePath === sourcePath,
    );
    if (!found) throw new NotFoundError();
    return found;
  }
  private readonly optionsFiles: GatewayFiles | undefined;
}
