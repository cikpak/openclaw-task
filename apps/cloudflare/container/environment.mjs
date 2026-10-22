import { resolve, relative, isAbsolute } from 'node:path';
export const root = process.env.RECOVERY_ROOT ?? '/recovery';
export const runtime =
  process.env.HELPER_RUNTIME ?? '/var/lib/messenger-helper';
export const state = `${root}/state`;
export function inside(path) {
  const delta = relative(root, resolve(path));
  return delta !== '' && !delta.startsWith('..') && !isAbsolute(delta);
}
export function environment() {
  Object.assign(process.env, {
    HOME: `${root}/home`,
    OPENCLAW_HOME: `${root}/home`,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: `${state}/openclaw.json`,
    OPENCLAW_OAUTH_DIR: `${state}/credentials`,
    OPENCLAW_WORKSPACE_DIR: `${root}/workspace`,
    XDG_CONFIG_HOME: `${root}/home/.config`,
    XDG_DATA_HOME: `${root}/home/.local/share`,
    XDG_STATE_HOME: `${root}/home/.local/state`,
    XDG_CACHE_HOME: `${root}/cache`,
    NODE_COMPILE_CACHE: `${runtime}/compile-cache`,
    TMPDIR: `${root}/tmp`,
  });
  if (inside(runtime)) throw new Error('Helper runtime cannot be captured');
  for (const name of ['HELPER_TOKEN', 'GATEWAY_TOKEN'])
    if ((process.env[name]?.length ?? 0) < 32)
      throw new Error('Missing helper credentials');
}
