import type { ChatSettings, ModelCapability } from '@messenger/contracts';
import { useState } from 'react';
import { Select, type SelectOption } from '../ui/Select';
import styles from './Settings.module.css';

export function selectModel(
  current: ChatSettings,
  model: ModelCapability,
): ChatSettings {
  const supports = (id: string) =>
    model.thinkingLevels.some((level) => level.id === id);
  const fallback = supports('medium')
    ? 'medium'
    : supports(model.thinkingDefault)
      ? model.thinkingDefault
      : (model.thinkingLevels[0]?.id ?? model.thinkingDefault);
  return {
    ...current,
    model: model.id,
    thinkingLevel:
      current.model === model.id && supports(current.thinkingLevel)
        ? current.thinkingLevel
        : fallback,
    fastMode: model.supportsFastMode && current.fastMode,
  };
}
export function ModelControls({
  models,
  value,
  onChange,
  disabled = false,
}: {
  models: ModelCapability[];
  value: ChatSettings;
  onChange: (value: ChatSettings) => void;
  disabled?: boolean;
}) {
  const model = models.find((m) => m.id === value.model);
  const [adjustment, setAdjustment] = useState('');
  function changeModel(id: string) {
    const next = models.find((m) => m.id === id);
    if (!next) return;
    const selected = selectModel(value, next);
    const changes = [];
    if (selected.thinkingLevel !== value.thinkingLevel)
      changes.push(
        `Thinking changed to ${next.thinkingLevels.find((level) => level.id === selected.thinkingLevel)?.label ?? selected.thinkingLevel}`,
      );
    if (value.fastMode && !selected.fastMode)
      changes.push('Speed changed to Standard');
    setAdjustment(
      changes.length ? `${changes.join('. ')} for this model.` : '',
    );
    onChange(selected);
  }
  const modelOptions: SelectOption[] = models.map((m) => ({
    value: m.id,
    label: `${m.name} · ${m.provider}${m.available ? '' : ' · unavailable'}`,
    disabled: !m.available,
  }));
  if (!model)
    modelOptions.unshift({
      value: value.model,
      label: value.model ? `${value.model} · unavailable` : 'Choose a model',
      disabled: true,
    });
  const thinkingOptions: SelectOption[] =
    model?.thinkingLevels.map((level) => ({
      value: level.id,
      label: level.label,
    })) ?? [];
  if (!thinkingOptions.some((level) => level.value === value.thinkingLevel))
    thinkingOptions.unshift({
      value: value.thinkingLevel,
      label: `${value.thinkingLevel} · no longer supported`,
      disabled: true,
    });
  const speedOptions: SelectOption[] = [
    { value: 'standard', label: 'Standard' },
  ];
  if (model?.supportsFastMode || value.fastMode)
    speedOptions.push({
      value: 'fast',
      label: model?.supportsFastMode
        ? 'Fast'
        : model?.fastModeSupport === 'unsupported'
          ? 'Fast · no longer supported'
          : 'Fast · support unconfirmed',
      disabled: !model?.supportsFastMode,
    });
  const controls = [
    {
      label: 'Model',
      value: value.model,
      options: modelOptions,
      disabled,
      onChange: changeModel,
    },
    {
      label: 'Thinking',
      value: value.thinkingLevel,
      options: thinkingOptions,
      disabled: disabled || !model || !model.thinkingLevels.length,
      onChange: (thinkingLevel: string) =>
        onChange({ ...value, thinkingLevel }),
    },
    {
      label: 'Speed',
      value: value.fastMode ? 'fast' : 'standard',
      options: speedOptions,
      disabled: disabled || !model?.supportsFastMode,
      onChange: (speed: string) =>
        onChange({ ...value, fastMode: speed === 'fast' }),
    },
  ];
  return (
    <div className={styles.modelControls}>
      {controls.map((control) => (
        <div className={styles.labelBlock} key={control.label}>
          {control.label}
          <Select {...control} />
        </div>
      ))}
      <p className={styles.hint}>
        {model?.supportsFastMode
          ? 'Thinking and speed options come from this model’s capabilities.'
          : model?.fastModeSupport === 'unsupported'
            ? 'This model reports that Fast is unsupported. Standard is available.'
            : 'The Gateway has not reported Fast support for this model. Standard is available; Fast stays disabled until support is confirmed.'}
      </p>
      {adjustment ? (
        <p role="status" className={styles.hint}>
          {adjustment}
        </p>
      ) : null}
    </div>
  );
}
