import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  chown,
  realpath,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { root, state, inside } from './environment.mjs';
import { validateIdentity } from './identity.mjs';
export const marker = `${state}/messenger-manager.json`;
function preserved(path) {
  const resolved = resolve(path);
  return (
    inside(resolved) &&
    !['cache', 'tmp'].some(
      (name) =>
        resolved === `${root}/${name}` ||
        resolved.startsWith(`${root}/${name}/`),
    )
  );
}
export function auditConfig(config) {
  const paths = [];
  const pathKeys =
    /^(workspace|agentDir|stateDir|configPath|oauthDir|store|storePath|persistPath|logFile|path|root|outputDir)$/;
  function walk(value, key = '') {
    if (typeof value === 'string' && pathKeys.test(key) && !preserved(value))
      throw new Error('Configured path must be explicit within recovery');
    if (typeof value === 'string' && value.startsWith('/')) paths.push(value);
    if (typeof value === 'string' && value.startsWith('/') && !preserved(value))
      throw new Error('Configured state escapes recovery');
    if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === 'object')
      for (const [name, item] of Object.entries(value)) walk(item, name);
  }
  walk(config);
  if (
    config.gateway?.nodes?.pairing?.autoApproveLocal !== false ||
    config.gateway?.tls?.enabled ||
    config.gateway?.port !== 18789 ||
    config.gateway?.bind !== 'lan'
  )
    throw new Error('Invalid private Gateway route');
  return paths;
}
export async function audit() {
  const config = JSON.parse(
    await readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'),
  );
  const paths = auditConfig(config);
  for (let path of [...paths, process.env.OPENCLAW_CONFIG_PATH, marker]) {
    while (path !== root) {
      try {
        if (!preserved(await realpath(path)))
          throw new Error('Configured symlink escapes recovery');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        path = dirname(path);
      }
    }
  }
  validateIdentity(JSON.parse(await readFile(marker, 'utf8')));
  return config;
}
export function defaults() {
  const model = process.env.DEFAULT_MODEL ?? 'anthropic/claude-sonnet-4-6';
  if (!/^[a-z0-9-]+\/[a-zA-Z0-9._:/-]+$/.test(model))
    throw new Error('Invalid default model');
  return {
    gateway: {
      mode: 'local',
      bind: 'lan',
      port: 18789,
      auth: { mode: 'token', token: '${GATEWAY_TOKEN}' },
      nodes: { pairing: { autoApproveLocal: false } },
      tls: { enabled: false },
      controlUi: { enabled: false },
    },
    agents: {
      ownership: 'explicit',
      defaults: {
        model: { primary: model },
        workspace: `${root}/workspace`,
        heartbeat: { every: '0m' },
        maxConcurrent: 10,
        systemAgent: { agentId: 'main' },
      },
      entries: { main: { name: 'System', workspace: `${root}/workspace` } },
    },
    tools: {
      allow: ['read', 'write', 'edit', 'web_fetch'],
      fs: { workspaceOnly: true },
      sessions: { visibility: 'self' },
      agentToAgent: { enabled: false },
      elevated: { enabled: false },
    },
  };
}
export async function initialize({ identity, config = defaults() }) {
  validateIdentity(identity);
  auditConfig(config);
  if ((await readdir(root)).length)
    throw new Error('Initialization requires pristine root');
  for (const path of [
    state,
    process.env.HOME,
    process.env.TMPDIR,
    process.env.XDG_CACHE_HOME,
    `${root}/workspace`,
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chown(path, 1000, 1000);
  }
  await chown(root, 1000, 1000);
  await writeFile(marker, JSON.stringify(identity), {
    flag: 'wx',
    mode: 0o600,
  });
  await chown(marker, 1000, 1000);
  await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config), {
    flag: 'wx',
    mode: 0o600,
  });
  await chown(process.env.OPENCLAW_CONFIG_PATH, 1000, 1000);
  return { initialized: true };
}
