import type { Config } from '../config.js';
import { GatewayFacade } from './facade.js';
import { NodeGatewayTransport } from './node-transport.js';
import { WorkspaceArtifacts } from './workspace-artifacts.js';
export { messageText } from './messages.js';
/** Legacy Node host and the native Worker adapter share the same Gateway semantics. */
export class OpenClawGateway extends GatewayFacade {
  constructor(config: Config) {
    const transport = new NodeGatewayTransport(config, (event) =>
      this.emit(event),
    );
    super(transport, new WorkspaceArtifacts(config.gatewayWorkspaceDir));
  }
}
