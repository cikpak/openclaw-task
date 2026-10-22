// Historical Node adapter regression fixture; never loaded by Cloudflare.
export const BACKEND_SCOPES = Object.freeze([
  'operator.read',
  'operator.write',
  'operator.admin',
]);

export function matchBackendRequest(request, identity) {
  if (!request || !identity || typeof request.requestId !== 'string')
    return false;
  const scopes = Array.isArray(request.scopes)
    ? [...request.scopes].sort()
    : [];
  const expected = [...BACKEND_SCOPES].sort();
  return (
    request.deviceId === identity.deviceId &&
    request.publicKey === identity.publicKey &&
    request.role === 'operator' &&
    identity.role === 'operator' &&
    Array.isArray(identity.scopes) &&
    [...identity.scopes].sort().join(',') === expected.join(',') &&
    scopes.join(',') === expected.join(',') &&
    (!request.roles || request.roles.every((role) => role === 'operator'))
  );
}

export function initialOpenClawConfig(model) {
  if (
    typeof model !== 'string' ||
    !/^[a-z0-9-]+\/[a-zA-Z0-9._:/-]+$/.test(model)
  ) {
    throw new Error('DEFAULT_MODEL must be a provider/model identifier');
  }
  return {
    gateway: {
      mode: 'local',
      bind: 'lan',
      port: 18789,
      auth: { mode: 'token', token: '${GATEWAY_TOKEN}' },
      tls: { enabled: true, autoGenerate: true },
      controlUi: { enabled: false },
    },
    agents: {
      ownership: 'explicit',
      defaults: {
        model: { primary: model },
        workspace: '/home/node/.openclaw/workspace',
        heartbeat: { every: '0m' },
        maxConcurrent: 10,
        systemAgent: { agentId: 'main' },
      },
      entries: {
        main: {
          name: 'System',
          workspace: '/home/node/.openclaw/workspace',
        },
      },
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
