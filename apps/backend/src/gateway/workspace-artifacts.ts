import { constants, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, opendir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Artifact } from '@messenger/contracts';
import { ApplicationError, NotFoundError } from '../errors.js';
import { FILE_LIMIT, safeFilename } from '../uploads/validation.js';
import type { GatewayMapping } from './types.js';

const prefix = 'messenger-workspace-v1:';
const bootstrap = new Set(
  [
    'AGENTS.md',
    'SOUL.md',
    'TOOLS.md',
    'IDENTITY.md',
    'USER.md',
    'HEARTBEAT.md',
    'BOOTSTRAP.md',
    'MEMORY.md',
    'auth-profiles.json',
    'openclaw.json',
    'device-token.json',
  ].map((name) => name.toLowerCase()),
);
const mime: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const allowed = new Set([
  ...Object.keys(mime),
  '.pptx',
  '.zip',
  '.html',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
]);
function relative(value: string): string {
  const path = value.startsWith('./') ? value.slice(2) : value;
  const segments = path.split('/');
  if (
    !path ||
    path.length > 1024 ||
    segments.length > 8 ||
    // OpenClaw stages user uploads here; these are inputs, not generated outputs.
    (segments[0]?.toLowerCase() === 'media' &&
      segments[1]?.toLowerCase() === 'inbound') ||
    segments.some(
      (part) =>
        !part ||
        part === '..' ||
        part.startsWith('.') ||
        ['uploads', 'keys', 'credentials', 'secrets'].includes(
          part.toLowerCase(),
        ) ||
        part.includes('\\') ||
        Array.from(part).some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    ) ||
    bootstrap.has(segments[0]!.toLowerCase())
  )
    throw new NotFoundError();
  return path;
}
function scope(mapping: GatewayMapping): void {
  if (
    !/^messenger-[a-f0-9-]{36}$/u.test(mapping.agentId) ||
    mapping.sessionKey !== `agent:${mapping.agentId}:main`
  )
    throw new NotFoundError();
}
function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))
  );
}
type Opened = {
  file: FileHandle;
  chain: [string, BigIntStats][];
  directories: FileHandle[];
};
async function closeOpened(opened: Opened): Promise<void> {
  await Promise.all([
    opened.file.close(),
    ...opened.directories.map((directory) => directory.close()),
  ]);
}
async function assertChain(chain: Opened['chain']): Promise<void> {
  for (const [path, before] of chain) {
    const after = await lstat(path, { bigint: true });
    if (
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    )
      throw new NotFoundError();
  }
}
/** Only this mounted workspace subtree is visible; no Gateway credentials/config are mounted. */
export class WorkspaceArtifacts {
  constructor(private readonly root: string | undefined) {}
  sourcePath(mapping: GatewayMapping, link: string): string {
    scope(mapping);
    if (link.startsWith('sandbox:')) link = link.slice('sandbox:'.length);
    try {
      link = decodeURIComponent(link);
    } catch {
      throw new NotFoundError();
    }
    const native = `/home/node/.openclaw/workspace/${mapping.agentId}/`;
    if (link.startsWith('/')) {
      if (!link.startsWith(native)) throw new NotFoundError();
      return relative(link.slice(native.length));
    }
    if (
      /^[a-z][a-z0-9+.-]*:/iu.test(link) ||
      link.includes('?') ||
      link.includes('#')
    )
      throw new NotFoundError();
    return relative(link);
  }
  id(mapping: GatewayMapping, path: string): string {
    scope(mapping);
    return Buffer.from(
      prefix +
        createHash('sha256')
          .update(
            JSON.stringify([
              mapping.agentId,
              mapping.sessionKey,
              relative(path),
            ]),
          )
          .digest('base64url'),
    ).toString('base64url');
  }
  handles(upstreamId: string): boolean {
    return upstreamId.startsWith(prefix);
  }
  private async path(
    mapping: GatewayMapping,
    upstreamId: string,
  ): Promise<string> {
    scope(mapping);
    const id = Buffer.from(upstreamId).toString('base64url');
    const artifact = (await this.list(mapping)).find((item) => item.id === id);
    if (!artifact?.sourcePath) throw new NotFoundError();
    return artifact.sourcePath;
  }
  private async safelyOpen(
    mapping: GatewayMapping,
    path: string,
  ): Promise<Opened> {
    if (!this.root) throw new NotFoundError();
    if (!allowed.has(extname(path).toLowerCase())) throw new NotFoundError();
    scope(mapping);
    const segments = relative(path).split('/');
    const { directories, chain } = await this.openDirectories(
      mapping,
      segments.slice(0, -1).join('/'),
    );
    const current = join(this.root, mapping.agentId, path);
    let file: FileHandle | undefined;
    try {
      file = await open(
        `/proc/self/fd/${directories.at(-1)!.fd}/${segments.at(-1)!}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await file.stat({ bigint: true });
      const opened = {
        file,
        chain: [...chain, [current, stat] as [string, BigIntStats]],
        directories,
      };
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(FILE_LIMIT))
        throw new NotFoundError();
      await assertChain(opened.chain);
      return opened;
    } catch (error) {
      await Promise.all([
        ...directories.map((directory) => directory.close()),
        ...(file ? [file.close()] : []),
      ]);
      throw error;
    }
  }
  private async openDirectories(
    mapping: GatewayMapping,
    path: string,
  ): Promise<{ directories: FileHandle[]; chain: Opened['chain'] }> {
    if (!this.root) throw new NotFoundError();
    scope(mapping);
    const parts = [
      this.root,
      mapping.agentId,
      ...(path ? relative(path).split('/') : []),
    ];
    const directories: FileHandle[] = [];
    const chain: Opened['chain'] = [];
    let current = parts[0]!;
    try {
      for (let i = 0; i < parts.length; i++) {
        if (i) current = join(current, parts[i]!);
        const anchored = i
          ? `/proc/self/fd/${directories.at(-1)!.fd}/${parts[i]!}`
          : current;
        const handle = await open(
          anchored,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        directories.push(handle);
        chain.push([current, await handle.stat({ bigint: true })]);
      }
      return { directories, chain };
    } catch (error) {
      await Promise.all(directories.map((directory) => directory.close()));
      throw error;
    }
  }
  private summary(
    mapping: GatewayMapping,
    path: string,
    size: number,
  ): Artifact {
    return {
      id: this.id(mapping, path),
      name: safeFilename(basename(path)),
      mimeType: mime[extname(path).toLowerCase()] ?? 'application/octet-stream',
      sizeBytes: size,
      sourcePath: path,
    };
  }
  async list(mapping: GatewayMapping): Promise<Artifact[]> {
    if (!this.root) return [];
    if (process.platform !== 'linux')
      throw new ApplicationError(
        503,
        'WORKSPACE_DOWNLOAD_UNAVAILABLE',
        'Generated file downloads require the Docker workspace bridge.',
      );
    scope(mapping);
    const result: { artifact: Artifact; mtime: number }[] = [];
    let inspected = 0;
    const visit = async (path: string, depth: number): Promise<void> => {
      if (depth > 7 || inspected >= 1000) return;
      const { directories } = await this.openDirectories(mapping, path);
      try {
        const entries = await opendir(
          `/proc/self/fd/${directories.at(-1)!.fd}`,
        );
        for await (const entry of entries) {
          if (++inspected > 1000) break;
          const name = path ? `${path}/${entry.name}` : entry.name;
          try {
            relative(name);
            if (entry.isDirectory()) await visit(name, depth + 1);
            else if (entry.isFile()) {
              const opened = await this.safelyOpen(mapping, name);
              try {
                const meta = await opened.file.stat();
                result.push({
                  artifact: this.summary(mapping, name, meta.size),
                  mtime: meta.mtimeMs,
                });
              } finally {
                await closeOpened(opened);
              }
            }
          } catch (error) {
            if (!(error instanceof NotFoundError) && !isMissing(error))
              throw error;
          }
        }
      } finally {
        await Promise.all(directories.map((directory) => directory.close()));
      }
    };
    try {
      await visit('', 0);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return result
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 100)
      .map((item) => item.artifact);
  }
  async download(
    mapping: GatewayMapping,
    upstreamId: string,
  ): Promise<{ artifact: Artifact; bytes: Buffer }> {
    const path = await this.path(mapping, upstreamId);
    let opened: Opened;
    try {
      opened = await this.safelyOpen(mapping, path);
    } catch (error) {
      if (isMissing(error)) throw new NotFoundError();
      throw error;
    }
    try {
      const buffer = Buffer.alloc(FILE_LIMIT + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await opened.file.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > FILE_LIMIT || (await opened.file.stat()).nlink !== 1)
        throw new NotFoundError();
      await assertChain(opened.chain);
      const bytes = buffer.subarray(0, length);
      return { artifact: this.summary(mapping, path, length), bytes };
    } finally {
      await closeOpened(opened);
    }
  }
}
