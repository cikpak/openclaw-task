import { describe, expect, it } from 'vitest';
import * as native from '../packages/contracts/src/agent-behavior.ts';
import * as browser from '../apps/frontend/src/lib/agent-behavior.ts';

describe('browser behavior adapter matches native contract without runtime contract imports', () => {
  it('retains identical limits, enum identifiers and defaults', () => {
    for (const key of [
      'CUSTOM_INSTRUCTIONS_LIMIT',
      'RESPONSE_STYLES',
      'PERSONALITIES',
      'DEFAULT_AGENT_BEHAVIOR',
    ])
      expect(browser[key]).toEqual(native[key]);
  });
  it('normalizes and compares all supported combinations identically', () => {
    for (const responseStyle of native.RESPONSE_STYLES)
      for (const personality of native.PERSONALITIES) {
        const value = {
          customInstructions: 'Unicode 🧠\nSecond line.',
          responseStyle,
          personality,
        };
        expect(browser.normalizeAgentBehavior(value)).toEqual(
          native.normalizeAgentBehavior(value),
        );
        expect(browser.agentBehaviorEqual(value, {})).toBe(
          native.agentBehaviorEqual(value, {}),
        );
        expect(browser.agentBehaviorValid(value)).toBe(
          native.agentBehaviorValid(value),
        );
      }
    expect(browser.normalizeAgentBehavior({})).toEqual(
      native.normalizeAgentBehavior({}),
    );
    expect(browser.agentBehaviorEqual({}, native.DEFAULT_AGENT_BEHAVIOR)).toBe(
      true,
    );
  });
  it('rejects malformed behavior and accepts legacy omissions with identical bounds', () => {
    for (const value of [
      {},
      { customInstructions: null },
      { customInstructions: 'x'.repeat(8000) },
      { customInstructions: 'x'.repeat(8001) },
      { responseStyle: 'made-up' },
      { personality: 'made-up' },
    ])
      expect(browser.agentBehaviorValid(value)).toBe(
        native.agentBehaviorValid(value),
      );
  });
});
