import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { audit } from './configuration.mjs';
import { inside } from './environment.mjs';
const internal =
  /^(?:\..*|AGENTS\.md|SOUL\.md|IDENTITY\.md|MEMORY\.md|USER\.md|TOOLS\.md|HEARTBEAT\.md|BOOTSTRAP\.md|openclaw\.json)$/i;
export function unsafeFileCharacters(value) {
  return (
    typeof value !== 'string' ||
    value.includes('\\') ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}
export async function fileScope({ agentId, sessionKey }) {
  if (
    !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(agentId ?? '') ||
    sessionKey !== `agent:${agentId}:main`
  )
    throw new Error('Invalid file owner');
  const config = await audit();
  const entry = config.agents?.entries?.[agentId];
  if (!entry || typeof entry.workspace !== 'string')
    throw new Error('Unknown file owner');
  const workspace = await realpath(entry.workspace);
  if (!inside(workspace)) throw new Error('Workspace escapes recovery');
  return { workspace, documentsRoot: resolve(workspace, 'documents') };
}
export async function openDocument(data) {
  const scope = await fileScope(data);
  if (unsafeFileCharacters(data.path)) throw new Error('Invalid file path');
  const path = resolve(scope.workspace, data.path);
  const delta = relative(scope.documentsRoot, path);
  if (
    !delta ||
    delta.startsWith('..') ||
    isAbsolute(delta) ||
    delta.split('/').some((part) => internal.test(part))
  )
    throw new Error('File is private');
  // Pin the opened inode, then validate its kernel-resolved target to defeat symlink swaps.
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const canonical = await realpath(`/proc/self/fd/${handle.fd}`);
    const root = await realpath(scope.documentsRoot);
    const target = relative(root, canonical);
    if (
      root !== scope.documentsRoot ||
      !target ||
      target.startsWith('..') ||
      isAbsolute(target) ||
      target.split('/').some((part) => internal.test(part))
    )
      throw new Error('File escapes documents');
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Not a regular file');
    return {
      handle,
      stat,
      path: canonical,
      documentsRoot: root,
      name: basename(canonical),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
