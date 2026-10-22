import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

// Exact ed53 bundled plugins whose schemas materialize an empty config object.
const emptyDefaults = new Set([
  'azure-speech',
  'copilot-proxy',
  'cua-computer',
  'device-pair',
  'document-extract',
  'file-transfer',
  'github-copilot',
  'linux-node',
  'memory-core',
  'microsoft-foundry',
  'opencode-go',
  'talk-voice',
  'tts-local-cli',
  'web-readability',
  'alibaba',
  'anthropic',
  'browser',
  'canvas',
  'clawrouter',
  'deepgram',
  'elevenlabs',
  'fal',
  'geolocation',
  'github',
  'google',
  'huggingface',
  'kie',
  'litellm',
  'lmstudio',
  'microsoft',
  'minimax',
  'nvidia',
  'ollama',
  'openrouter',
  'runway',
  'senseaudio',
  'sglang',
  'together',
  'vllm',
  'xai',
]);
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const loading = 'plugins.entries.codex.config.codexDynamicToolsLoading';
function addedDefault(path, value) {
  if (
    path === 'meta.migrations.modelPolicyAllowlist' ||
    path === 'meta.migrations.utilityModelSeparation'
  )
    return value === true;
  if (path === 'plugins.entries.codex.config.codexDynamicToolsExclude')
    return Array.isArray(value) && value.length === 0;
  if (path === 'plugins.entries.openai.config.personality')
    return value === 'friendly';
  const match = /^plugins\.entries\.([a-z-]+)\.config$/u.exec(path);
  return (
    !!match &&
    emptyDefaults.has(match[1]) &&
    object(value) &&
    Object.keys(value).length === 0
  );
}
/** Compare private native config without printing values on an assertion failure. */
export function assertPreserved(before, after) {
  assert.equal(
    after?.plugins?.entries?.codex?.config?.codexDynamicToolsLoading ===
      'direct',
    true,
    'Direct policy must be present',
  );
  const compare = (previous, current, path = '') => {
    if (path === loading) {
      assert.equal(current === 'direct', true, 'Direct policy must be present');
      return;
    }
    if (path === 'meta.lastTouchedVersion') {
      assert.equal(
        current === '2026.10.1',
        true,
        'Native touch version must match the pin',
      );
      return;
    }
    if (path === 'meta.lastTouchedAt') {
      assert.equal(
        typeof current === 'string' && Number.isFinite(Date.parse(current)),
        true,
        'Native touch time must be valid',
      );
      return;
    }
    if (previous === undefined && addedDefault(path, current)) return;
    if (object(current) && (previous === undefined || object(previous))) {
      const keys = new Set([
        ...Object.keys(previous ?? {}),
        ...Object.keys(current),
      ]);
      if (keys.size === 0) {
        assert.equal(
          previous !== undefined,
          true,
          'Unexpected empty config addition',
        );
        return;
      }
      for (const key of keys)
        compare(previous?.[key], current[key], path ? `${path}.${key}` : key);
      return;
    }
    assert.equal(
      isDeepStrictEqual(previous, current),
      true,
      'An unrelated native configuration value changed',
    );
  };
  compare(before, after);
}
