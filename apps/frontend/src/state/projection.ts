import { create } from 'zustand';
import type { ProjectionState } from './projectionTypes';
import { chronological, withoutKey } from './projectionHelpers';
import { projectionSnapshot } from './projectionSnapshot';
import { projectionResults } from './projectionResults';
import { projectionEvents } from './projectionEvents';
import { useDrafts } from './drafts';
import { useModelCatalog } from './catalog';
export const useChatProjection = create<ProjectionState>((set, get) => ({
  chats: {},
  snapshots: {},
  tools: {},
  generation: null,
  connectionEpoch: 1,
  needsReconnect: false,
  sequence: -1,
  chatSequences: {},
  snapshotReadOrders: {},
  structuralSequences: {},
  runEventSequences: {},
  toolEventSequences: {},
  resyncChats: {},
  runBacklog: {},
  runDropped: {},
  olderHistory: {},
  transport: 'connecting',
  deletedChats: {},
  connection: 'connecting',
  replaceCatalog: (chats) =>
    set((state) => ({
      chats: Object.fromEntries(chats.map((chat) => [chat.id, chat])),
      snapshots: Object.fromEntries(
        Object.entries(state.snapshots).filter(([id]) =>
          chats.some((chat) => chat.id === id),
        ),
      ),
      tools: Object.fromEntries(
        Object.entries(state.tools).filter(([id]) =>
          chats.some((chat) => chat.id === id),
        ),
      ),
      olderHistory: Object.fromEntries(
        Object.entries(state.olderHistory).filter(([id]) =>
          chats.some((chat) => chat.id === id),
        ),
      ),
    })),
  mergeChat: (chat) =>
    set((state) =>
      state.deletedChats[chat.id] ||
      (state.chats[chat.id]?.version ?? -1) > chat.version
        ? {}
        : { chats: { ...state.chats, [chat.id]: chat } },
    ),
  applyCatalogResult: (chats, sequences, requestEpoch) => {
    let state = get();
    if (requestEpoch !== state.connectionEpoch) return;
    const ids = new Set(chats.map((chat) => chat.id));
    set({
      deletedChats: Object.fromEntries(
        Object.entries(state.deletedChats).filter(
          ([id, epoch]) => epoch >= state.connectionEpoch || ids.has(id),
        ),
      ),
    });
    state = get();
    const catalog = chats.flatMap((chat) => {
      if (state.deletedChats[chat.id]) return [];
      const current = state.chats[chat.id];
      return [
        (state.chatSequences[chat.id] ?? -1) !== (sequences[chat.id] ?? -1) &&
        current
          ? current
          : current && current.version > chat.version
            ? current
            : chat,
      ];
    });
    for (const chat of Object.values(state.chats))
      if (
        (state.chatSequences[chat.id] ?? -1) !== (sequences[chat.id] ?? -1) &&
        !catalog.some((item) => item.id === chat.id)
      )
        catalog.push(chat);
    const present = new Set(catalog.map((chat) => chat.id));
    // The complete authenticated catalog proves chats deleted while we were offline.
    for (const id of Object.keys(state.chats))
      if (!present.has(id)) get().releaseConfirmedChat(id);
    get().replaceCatalog(catalog);
  },
  releaseConfirmedChat: (id) => {
    const current = get();
    const deletedChats = {
      ...current.deletedChats,
      [id]: current.connectionEpoch,
    };
    set({
      chats: withoutKey(current.chats, id),
      snapshots: withoutKey(current.snapshots, id),
      tools: withoutKey(current.tools, id),
      olderHistory: withoutKey(current.olderHistory, id),
      runBacklog: withoutKey(current.runBacklog, id),
      runDropped: withoutKey(current.runDropped, id),
      resyncChats: withoutKey(current.resyncChats, id),
      chatSequences: withoutKey(current.chatSequences, id),
      structuralSequences: withoutKey(current.structuralSequences, id),
      runEventSequences: withoutKey(current.runEventSequences, id),
      snapshotReadOrders: withoutKey(current.snapshotReadOrders, id),
      toolEventSequences: withoutKey(current.toolEventSequences, id),
      deletedChats,
      needsReconnect: Object.keys(deletedChats).length >= 100,
    });
    useDrafts.getState().discardChat(id);
    useModelCatalog.getState().removeScope(id);
  },
  beginConnection: () =>
    set((state) => ({
      generation: null,
      connectionEpoch: state.connectionEpoch + 1,
      needsReconnect: false,
      sequence: -1,
      chatSequences: {},
      snapshotReadOrders: {},
      structuralSequences: {},
      runEventSequences: {},
      toolEventSequences: {},
      resyncChats: {},
      runBacklog: {},
      runDropped: {},
      connection: 'connecting',
      transport: 'connecting',
    })),
  markUnavailable: () => set({ connection: 'unavailable' }),
  markTransportOpen: () => set({ transport: 'open' }),
  markTransportClosed: () => set({ transport: 'closed' }),
  ...projectionSnapshot(set),
  ...projectionResults(set, get),
  prependHistory: (chatId, messages, cursor, hasOlder) => {
    const state = get();
    const current = state.snapshots[chatId];
    if (!current) return;
    const all = chronological([
      ...new Map(
        [...messages, ...(state.olderHistory[chatId]?.messages ?? [])].map(
          (message) => [message.id, message],
        ),
      ).values(),
    ]);
    set({
      olderHistory: {
        ...state.olderHistory,
        [chatId]: { messages: all, cursor, hasOlder },
      },
    });
    const ids = new Set(current.messages.map((message) => message.id));
    set((latest) => ({
      snapshots: {
        ...latest.snapshots,
        [chatId]: {
          ...current,
          messages: chronological([
            ...all.filter((message) => !ids.has(message.id)),
            ...current.messages,
          ]),
          historyCursor: cursor,
          hasOlderHistory: hasOlder,
        },
      },
    }));
  },
  ...projectionEvents(set, get),
  clear: () =>
    set({
      chats: {},
      snapshots: {},
      tools: {},
      generation: null,
      connectionEpoch: 1,
      needsReconnect: false,
      sequence: -1,
      chatSequences: {},
      snapshotReadOrders: {},
      structuralSequences: {},
      runEventSequences: {},
      toolEventSequences: {},
      resyncChats: {},
      runBacklog: {},
      runDropped: {},
      olderHistory: {},
      transport: 'connecting',
      deletedChats: {},
      connection: 'connecting',
    }),
}));
