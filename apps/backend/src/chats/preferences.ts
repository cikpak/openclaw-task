import type { ChatSettings, Preferences } from '@messenger/contracts';
import { DEFAULT_AGENT_BEHAVIOR } from '@messenger/contracts';
import { z } from 'zod';
import type { Store } from '../storage/store.js';
import type { Gateway, GatewayMapping } from '../gateway/types.js';
import { ApplicationError } from '../errors.js';
import { preferencesSchema } from '../schemas.js';
import { requireVersion } from './queue.js';
export function readPreferences(store: Store): Preferences {
  const row = store.db
    .prepare('SELECT json FROM preferences WHERE id = 1')
    .get();
  if (row)
    return preferencesSchema.parse(
      JSON.parse(z.object({ json: z.string() }).parse(row).json),
    );
  return {
    version: 1,
    busySendBehavior: 'queue',
    defaults: {
      ...DEFAULT_AGENT_BEHAVIOR,
      model: 'unconfigured',
      thinkingLevel: 'off',
      fastMode: false,
    },
  };
}
export function savePreferences(
  store: Store,
  input: Omit<Preferences, 'version'>,
  version?: string,
): Preferences {
  const previous = readPreferences(store);
  requireVersion(previous.version, version);
  const next = preferencesSchema.parse({
    ...input,
    version: previous.version + 1,
  });
  store.db
    .prepare(
      'INSERT INTO preferences VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
    )
    .run(JSON.stringify(next));
  return next;
}
export async function validateSettings(
  gateway: Gateway,
  settings: ChatSettings,
  target?: GatewayMapping,
): Promise<void> {
  const models = await gateway.models(target);
  const model = models.find((m) => m.id === settings.model && m.available);
  if (
    !model ||
    !model.thinkingLevels.some(
      (level) => level.id === settings.thinkingLevel,
    ) ||
    (settings.fastMode && !model.supportsFastMode)
  )
    throw new ApplicationError(
      422,
      'CAPABILITIES_CHANGED',
      'The model options changed. Refresh available models and adjust your selection.',
    );
}
