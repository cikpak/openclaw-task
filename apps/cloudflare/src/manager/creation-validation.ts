import type { ChatSettings } from '@messenger/contracts';
import { ApplicationError } from '../../../backend/src/errors.js';
import type { Store } from '../../../backend/src/storage/store.js';
import { modelCache } from './cached-models.js';
/** An absent offline catalog defers validation; a sentinel is never a real model. */
export function validateCachedCreation(
  store: Store,
  settings: ChatSettings,
): void {
  const models = modelCache(store).read();
  const model = models.find(
    (model) => model.id === settings.model && model.available,
  );
  if (
    settings.model === 'unconfigured' ||
    (models.length &&
      (!model ||
        !model.thinkingLevels.some(
          (level) => level.id === settings.thinkingLevel,
        ) ||
        (settings.fastMode && !model.supportsFastMode)))
  )
    throw new ApplicationError(
      422,
      'CAPABILITIES_CHANGED',
      'The model options changed. Refresh available models and adjust your selection.',
    );
}
