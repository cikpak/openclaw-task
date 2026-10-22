import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
export function fallbackContext(env, cwd = process.cwd()) {
  const namespace = env.CLOUDFLARE_WORKSPACE_ID;
  assert.match(
    namespace ?? '',
    /^[a-f0-9]{12}$/u,
    'Exact acceptance namespace required',
  );
  assert.equal(env.ACCEPTANCE_PROJECT, `messenger-acceptance-${namespace}`);
  const stateDir = join(resolve(cwd), '.context', `acceptance-${namespace}`);
  assert.equal(
    env.CLOUDFLARE_STATE_DIR,
    stateDir,
    'Exact owned state required',
  );
  assert.equal(env.ACCEPTANCE_RUNTIME_FILE, join(stateDir, 'runtime.json'));
  assert.match(env.CLOUDFLARE_PORT ?? '', /^\d{1,5}$/u);
  const port = Number(env.CLOUDFLARE_PORT);
  assert.ok(port > 0 && port <= 65535);
  const harnessOrigin = `http://127.0.0.1:${port}`;
  assert.equal(env.ACCEPTANCE_HARNESS_ORIGIN, harnessOrigin);
  return {
    namespace,
    stateDir,
    harnessOrigin,
    directory: join(resolve(cwd), '.context', 'ui-fallback', namespace),
  };
}
