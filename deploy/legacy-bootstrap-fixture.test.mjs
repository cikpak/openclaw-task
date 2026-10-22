import { describe, expect, it } from 'vitest';
import {
  BACKEND_SCOPES,
  initialOpenClawConfig,
  matchBackendRequest,
} from './legacy-bootstrap-fixture.mjs';

describe('device bootstrap trust boundary', () => {
  const identity = {
    deviceId: 'backend-device',
    publicKey: 'backend-key',
    role: 'operator',
    scopes: [...BACKEND_SCOPES],
  };
  const request = { ...identity, requestId: 'exact-request' };
  it('matches only the exact identity, role, and scopes', () => {
    expect(matchBackendRequest(request, identity)).toBe(true);
    for (const mutation of [
      { deviceId: 'other' },
      { publicKey: 'other' },
      { role: 'node' },
      { scopes: ['operator.admin', 'operator.pairing'] },
      { roles: ['operator', 'node'] },
    ]) {
      expect(matchBackendRequest({ ...request, ...mutation }, identity)).toBe(
        false,
      );
    }
    expect(
      matchBackendRequest(request, { ...identity, scopes: ['operator.admin'] }),
    ).toBe(false);
  });
  it('enforces restricted workspace tools in generated config', () => {
    const config = initialOpenClawConfig('anthropic/claude-sonnet-4-5');
    expect(config.tools.allow).toEqual(['read', 'write', 'edit', 'web_fetch']);
    expect(config.tools.fs.workspaceOnly).toBe(true);
    expect(config.tools.agentToAgent.enabled).toBe(false);
    expect(config.gateway.auth.token).toBe('${GATEWAY_TOKEN}');
    expect(config.gateway.tls.enabled).toBe(true);
    expect(config.agents.ownership).toBe('explicit');
    expect(config.agents.entries.main.name).toBe('System');
    expect(config.agents.defaults.heartbeat.every).toBe('0m');
    expect(config.agents.defaults.maxConcurrent).toBe(10);
    expect(config.agents.defaults.systemAgent.agentId).toBe('main');
    expect(config.agents).not.toHaveProperty('list');
    expect(() => initialOpenClawConfig('../invalid')).toThrow();
  });
});
