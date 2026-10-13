import { describe, expect, it } from 'vitest';
import type { ChatSettings, ModelCapability } from '@messenger/contracts';
import { selectModel } from './ModelControls';
import { settingsValid } from '../lib/validation';
import {
  DEFAULT_AGENT_BEHAVIOR,
  normalizeAgentBehavior,
} from '../lib/agent-behavior';

const model: ModelCapability = {
  id: 'test/reasoning',
  name: 'Reasoning',
  provider: 'test',
  available: true,
  thinkingLevels: [{ id: 'medium', label: 'Medium' }],
  thinkingDefault: 'medium',
  supportsFastMode: false,
  input: ['text'],
};
describe('agent behavior client preservation', () => {
  it('copies new-agent defaults through model selection without dropping them', () => {
    const value: ChatSettings = {
      model: 'test/other',
      thinkingLevel: 'off',
      fastMode: true,
      customInstructions: 'Use examples.',
      responseStyle: 'concise',
      personality: 'friendly',
    };
    expect(selectModel(value, model)).toEqual({
      ...value,
      model: model.id,
      thinkingLevel: 'medium',
      fastMode: false,
    });
  });
  it('accepts legacy responses and validates optional behavior fields', () => {
    const value: ChatSettings = {
      model: 'test/other',
      thinkingLevel: 'off',
      fastMode: false,
    };
    expect(settingsValid(value)).toBe(true);
    expect(normalizeAgentBehavior(value)).toEqual(DEFAULT_AGENT_BEHAVIOR);
    expect(
      settingsValid({ ...value, customInstructions: 'x'.repeat(8001) }),
    ).toBe(false);
    expect(settingsValid({ ...value, responseStyle: 'fake' })).toBe(false);
    expect(settingsValid({ ...value, personality: 'fake' })).toBe(false);
    expect(settingsValid({ ...value, ...DEFAULT_AGENT_BEHAVIOR })).toBe(true);
  });
});
