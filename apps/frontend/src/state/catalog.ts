import { create } from 'zustand';
import type { ModelCapability } from '@messenger/contracts';
import { request } from '../lib/api';
import { modelValid, record } from '../lib/validation';
import { useChatProjection } from './projection';
import { withoutKey } from './projectionHelpers';
interface CatalogState {
  catalogs: Record<string, ModelCapability[]>;
  load(scope?: string, refresh?: boolean): Promise<ModelCapability[]>;
  clear(): void;
  removeScope(scope: string): void;
}
export const useModelCatalog = create<CatalogState>((set) => ({
  catalogs: {},
  load: async (scope, refresh = false) => {
    const epoch = useChatProjection.getState().connectionEpoch;
    const { data } = await request(
      `/api/models?${new URLSearchParams({ ...(scope ? { chatId: scope } : {}), ...(refresh ? { refresh: 'true' } : {}) })}`,
    );
    if (
      !record(data) ||
      !Array.isArray(data.models) ||
      !data.models.every(modelValid)
    )
      throw new Error('Model information is unavailable. Try again shortly.');
    if (
      !scope ||
      (useChatProjection.getState().chats[scope] &&
        !useChatProjection.getState().deletedChats[scope] &&
        epoch === useChatProjection.getState().connectionEpoch)
    )
      set((state) => ({
        catalogs: {
          ...state.catalogs,
          [scope ?? 'defaults']: data.models as ModelCapability[],
        },
      }));
    return data.models;
  },
  clear: () => set({ catalogs: {} }),
  removeScope: (scope) =>
    set((state) => ({ catalogs: withoutKey(state.catalogs, scope) })),
}));
