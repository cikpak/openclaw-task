import { z } from 'zod';
import type { GatewayContext } from './context.js';
import type { GatewayMapping } from './types.js';
import { ApplicationError, NotFoundError } from '../errors.js';
import {
  decodeArtifactId,
  projectArtifactDownload,
  projectArtifacts,
} from './artifacts.js';
export class FileOperations {
  constructor(private readonly context: GatewayContext) {}
  async artifacts(mapping: GatewayMapping) {
    const [general, images] = await Promise.all([
      this.context.request('artifacts.list', {
        sessionKey: mapping.sessionKey,
        agentId: mapping.agentId,
      }),
      // Inline transcript images use the pinned Gateway's separate paginated index.
      this.context.request('artifacts.list', {
        sessionKey: mapping.sessionKey,
        agentId: mapping.agentId,
        type: 'image',
        limit: 4,
      }),
    ]);
    const catalog = new Map(
      [
        ...projectArtifacts(general, mapping),
        ...projectArtifacts(images, mapping),
      ].map((item) => [item.id, item]),
    );
    const workspace = await this.context.workspace.list(mapping);
    return [...workspace, ...catalog.values()].slice(0, 100);
  }
  async artifact(mapping: GatewayMapping, id: string) {
    const artifactId = decodeArtifactId(id);
    if (this.context.workspace.handles(artifactId))
      return this.context.workspace.download(mapping, artifactId);
    try {
      return projectArtifactDownload(
        await this.context.request('artifacts.download', {
          sessionKey: mapping.sessionKey,
          agentId: mapping.agentId,
          artifactId,
        }),
        mapping,
        artifactId,
      );
    } catch (error) {
      const rejected = z
        .object({
          code: z.literal('INVALID_REQUEST'),
          details: z.object({ type: z.string() }),
        })
        .safeParse(error);
      if (
        rejected.success &&
        ['artifact_not_found', 'artifact_scope_not_found'].includes(
          rejected.data.details.type,
        )
      )
        throw new NotFoundError();
      if (
        rejected.success &&
        rejected.data.details.type === 'artifact_download_unsupported'
      )
        throw new ApplicationError(
          422,
          'ARTIFACT_DOWNLOAD_UNSUPPORTED',
          'OpenClaw cannot safely transfer this artifact.',
        );
      throw error;
    }
  }
  async resolveArtifact(mapping: GatewayMapping, path: string) {
    const sourcePath = this.context.workspace.sourcePath(mapping, path);
    const artifact = (await this.artifacts(mapping)).find(
      (item) => item.sourcePath === sourcePath,
    );
    if (!artifact) throw new NotFoundError();
    return artifact;
  }
}
