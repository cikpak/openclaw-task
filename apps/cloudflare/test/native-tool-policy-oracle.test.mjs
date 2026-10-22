import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPreserved } from './native-tool-policy-oracle.mjs';

function fixture() {
  const before = {
    agents: { defaults: { model: { primary: 'mock/test-model' } } },
    tools: { allow: ['read', 'write', 'edit'] },
    gateway: { auth: { token: 'test-private' }, reload: { mode: 'hybrid' } },
    plugins: {
      entries: {
        codex: { config: { custom: 'keep' } },
        foreign: { enabled: false, config: { value: 'keep' } },
      },
    },
    meta: { migrations: { existing: true } },
  };
  const after = structuredClone(before);
  after.plugins.entries.codex.config.codexDynamicToolsLoading = 'direct';
  after.plugins.entries.codex.config.codexDynamicToolsExclude = [];
  after.plugins.entries.openai = { config: { personality: 'friendly' } };
  after.plugins.entries['document-extract'] = { config: {} };
  after.meta.migrations.modelPolicyAllowlist = true;
  after.meta.migrations.utilityModelSeparation = true;
  after.meta.lastTouchedVersion = '2026.10.1';
  after.meta.lastTouchedAt = '2026-10-22T10:00:00.000Z';
  return { before, after };
}
test('accepts only declared native defaults and the one desired policy', () => {
  const f = fixture();
  assertPreserved(f.before, f.after);
});
test('requires direct policy even when both snapshots omit the field', () => {
  const f = fixture();
  assert.throws(() => assertPreserved(f.before, f.before));
});
test('rejects a foreign setting change and executable allowlist expansion', () => {
  for (const mutate of [
    (value) => {
      value.plugins.entries.foreign.config.value = 'changed';
    },
    (value) => {
      value.tools.allow.push('exec');
    },
    (value) => {
      value.gateway.reload.mode = 'off';
    },
    (value) => {
      delete value.gateway.auth;
    },
  ]) {
    const f = fixture();
    mutate(f.after);
    assert.throws(() => assertPreserved(f.before, f.after));
  }
});
test('rejects unknown additions, nondefault plugin config and extra migration metadata', () => {
  for (const mutate of [
    (value) => {
      value.plugins.entries.unknown = { config: {} };
    },
    (value) => {
      value.plugins.entries['document-extract'].config.enabled = true;
    },
    (value) => {
      value.plugins.entries.openai.config.personality = 'off';
    },
    (value) => {
      value.meta.migrations.unproven = true;
    },
  ]) {
    const f = fixture();
    mutate(f.after);
    assert.throws(() => assertPreserved(f.before, f.after));
  }
});
test('preserves pre-existing explicit values even on paths having native defaults', () => {
  const f = fixture();
  f.before.plugins.entries.openai = { config: { personality: 'off' } };
  assert.throws(() => assertPreserved(f.before, f.after));
  f.after.plugins.entries.openai.config.personality = 'off';
  assertPreserved(f.before, f.after);
});

test('does not replace an existing exclude array or false migration value with defaults', () => {
  for (const mutate of [
    (value) => {
      value.plugins.entries.codex.config.codexDynamicToolsExclude = ['read'];
    },
    (value) => {
      value.meta.migrations.modelPolicyAllowlist = false;
    },
  ]) {
    const f = fixture();
    mutate(f.before);
    assert.throws(() => assertPreserved(f.before, f.after));
  }
});
