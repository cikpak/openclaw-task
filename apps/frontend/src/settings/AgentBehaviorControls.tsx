import { useId } from 'react';
import type { ChatSettings } from '@messenger/contracts';
import {
  CUSTOM_INSTRUCTIONS_LIMIT,
  normalizeAgentBehavior,
  PERSONALITIES,
  RESPONSE_STYLES,
} from '../lib/agent-behavior';
import { Select } from '../ui/Select';
import styles from './Settings.module.css';

const title = (value: string) => value[0]!.toUpperCase() + value.slice(1);
const styleOptions = RESPONSE_STYLES.map((value) => ({
  value,
  label: title(value),
}));
const personalityOptions = PERSONALITIES.map((value) => ({
  value,
  label: title(value),
}));

export function AgentBehaviorControls({
  value,
  onChange,
  disabled = false,
}: {
  value: ChatSettings;
  onChange: (value: ChatSettings) => void;
  disabled?: boolean;
}) {
  const helpId = useId();
  const behavior = normalizeAgentBehavior(value);
  return (
    <div className={styles.behaviorControls}>
      <div className={styles.row}>
        <div className={styles.labelBlock}>
          Response style
          <Select
            label="Response style"
            value={behavior.responseStyle}
            options={styleOptions}
            disabled={disabled}
            onChange={(responseStyle) => {
              if (RESPONSE_STYLES.some((style) => style === responseStyle))
                onChange({
                  ...value,
                  responseStyle: responseStyle as typeof behavior.responseStyle,
                });
            }}
          />
        </div>
        <div className={styles.labelBlock}>
          Personality
          <Select
            label="Personality"
            value={behavior.personality}
            options={personalityOptions}
            disabled={disabled}
            onChange={(personality) => {
              if (PERSONALITIES.some((preset) => preset === personality))
                onChange({
                  ...value,
                  personality: personality as typeof behavior.personality,
                });
            }}
          />
        </div>
      </div>
      <label className={styles.labelBlock}>
        Custom instructions
        <textarea
          className={styles.instructions}
          value={behavior.customInstructions}
          disabled={disabled}
          rows={5}
          maxLength={CUSTOM_INSTRUCTIONS_LIMIT}
          aria-describedby={helpId}
          onChange={(event) =>
            onChange({ ...value, customInstructions: event.target.value })
          }
          placeholder="Describe how this agent should work and respond…"
        />
      </label>
      <div id={helpId} className={styles.instructionsHelp}>
        <span>
          Optional guidance. Instructions do not change tool permissions.
        </span>
        <span className={styles.instructionsCount}>
          {behavior.customInstructions.length.toLocaleString('en-US')} / 8,000
        </span>
      </div>
    </div>
  );
}
