import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { gatewayEnvironment } from '../container/gateway-environment.mjs';
test('native child inherits provider and native config but no helper/R2/control credentials', () => {
  const env = gatewayEnvironment({
    PATH: process.env.PATH,
    OPENAI_API_KEY: 'provider',
    ANTHROPIC_API_KEY: 'anthropic',
    GATEWAY_TOKEN: 'gateway',
    OPENCLAW_CONFIG_PATH: '/recovery/state/openclaw.json',
    HELPER_TOKEN: 'privatehelper',
    R2_ORIGIN: 'private-r2',
    R2_SECRET_ACCESS_KEY: 'private-r2key',
    AWS_SECRET_ACCESS_KEY: 'private-aws',
    BOOT_ID: 'private-boot',
    EXPECTED_MANAGER_PUBLIC_KEY: 'privateidentity',
    RESTORE_EXPECTED: '1',
    CF_TOKEN: 'privatecf',
  });
  const result = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
    { env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  const child = JSON.parse(result.stdout);
  assert.equal(child.OPENAI_API_KEY, 'provider');
  assert.equal(child.ANTHROPIC_API_KEY, 'anthropic');
  assert.equal(child.GATEWAY_TOKEN, 'gateway');
  assert.equal(child.OPENCLAW_CONFIG_PATH, '/recovery/state/openclaw.json');
  assert.equal(
    Object.keys(child).some((key) =>
      /HELPER|R2|AWS|EXPECTED_MANAGER|BOOT_ID|RESTORE_EXPECTED|CF_TOKEN/.test(
        key,
      ),
    ),
    false,
  );
});
