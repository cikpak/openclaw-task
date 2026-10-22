import { create } from 'zustand';
import type { Preferences } from '@messenger/contracts';
import { request } from '../lib/api';
import { preferencesValid } from '../lib/validation';
interface PreferenceRead {
  preferences: Preferences;
  etag: string;
}
interface PreferenceState {
  preferences: Preferences | null;
  etag: string | null;
  load(): Promise<PreferenceRead>;
  save(
    preferences: Omit<Preferences, 'version'>,
    expectedEtag: string,
  ): Promise<PreferenceRead>;
  clear(): void;
}
export const usePreferences = create<PreferenceState>((set) => ({
  preferences: null,
  etag: null,
  load: async () => {
    const { data, etag } = await request('/api/preferences');
    if (!preferencesValid(data))
      throw new Error('Preferences could not be loaded.');
    const loaded = { preferences: data, etag: etag ?? `"${data.version}"` };
    set((state) =>
      (state.preferences?.version ?? -1) > data.version ? {} : loaded,
    );
    return loaded;
  },
  save: async (preferences, expectedEtag) => {
    const { data, etag } = await request('/api/preferences', {
      method: 'PATCH',
      headers: { 'If-Match': expectedEtag },
      body: JSON.stringify(preferences),
    });
    if (!preferencesValid(data))
      throw new Error(
        'Preferences response was invalid. Reload before trying again.',
      );
    const saved = { preferences: data, etag: etag ?? `"${data.version}"` };
    set((state) =>
      (state.preferences?.version ?? -1) > data.version ? {} : saved,
    );
    return saved;
  },
  clear: () => set({ preferences: null, etag: null }),
}));
