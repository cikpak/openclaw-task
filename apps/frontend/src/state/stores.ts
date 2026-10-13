import { create } from 'zustand';
import type {
  Attachment,
  ChatSnapshot,
  ChatSummary,
  ConversationEvent,
  ModelCapability,
  Message,
  Preferences,
  ToolActivity,
} from '@messenger/contracts';
import { request } from '../lib/api';
import { modelValid, preferencesValid, record } from '../lib/validation';
/** One display boundary for snapshots and older pages. Unknown positions stay stable. */
function chronological(messages: Message[]): Message[] {
  const unique = [
    ...new Map(messages.map((message) => [message.id, message])).values(),
  ];
  const sequenced = unique.filter(
    (message) => message.historySequence !== undefined,
  );
  const ordered =
    sequenced.length > 1
      ? sequenced.sort((a, b) => a.historySequence! - b.historySequence!)
      : unique
          .filter((message) => message.createdAt > 0)
          .sort((a, b) => a.createdAt - b.createdAt);
  const positioned = new Set(ordered.map((message) => message.id));
  let index = 0;
  return unique.map((message) =>
    positioned.has(message.id) ? ordered[index++]! : message,
  );
}
function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}
function toolWatermarks(
  tools: ToolActivity[],
  sequences: Record<string, number>,
): Record<string, number> {
  const retained: Record<string, number> = {};
  for (const tool of tools) {
    const sequence = sequences[tool.id];
    if (sequence !== undefined) retained[tool.id] = sequence;
  }
  return retained;
}
function projectRun(
  previous: ChatSnapshot['activeRun'],
  event: Extract<ConversationEvent, { type: 'conversation.run.text' }>,
) {
  const text = event.replace
    ? event.text
    : (previous?.id === event.runId ? previous.text : '') + event.text;
  return {
    id: event.runId,
    sequence: event.runSequence,
    text: text.slice(0, 256 * 1024),
    truncated:
      text.length > 256 * 1024 ||
      (event.truncated ??
        (event.replace ? false : (previous?.truncated ?? false))),
  };
}

interface ProjectionState {
  chats: Record<string, ChatSummary>;
  snapshots: Record<string, ChatSnapshot>;
  tools: Record<string, ToolActivity[]>;
  generation: string | null;
  connectionEpoch: number;
  needsReconnect: boolean;
  sequence: number;
  chatSequences: Record<string, number>;
  snapshotReadOrders: Record<string, number>;
  structuralSequences: Record<string, number>;
  runEventSequences: Record<string, number>;
  toolEventSequences: Record<string, Record<string, number>>;
  resyncChats: Record<string, boolean>;
  runBacklog: Record<
    string,
    Extract<ConversationEvent, { type: 'conversation.run.text' }>[]
  >;
  runDropped: Record<
    string,
    Extract<ConversationEvent, { type: 'conversation.run.text' }>
  >;
  olderHistory: Record<
    string,
    { messages: Message[]; cursor: string | null; hasOlder: boolean }
  >;
  transport: 'connecting' | 'open' | 'closed';
  deletedChats: Record<string, number>;
  connection: 'connecting' | 'ready' | 'unavailable';
  replaceCatalog(chats: ChatSummary[]): void;
  applyCatalogResult(
    chats: ChatSummary[],
    sequences: Record<string, number>,
    requestEpoch: number,
  ): void;
  releaseConfirmedChat(chatId: string): void;
  mergeChat(chat: ChatSummary): void;
  receiveEvent(event: ConversationEvent): void;
  beginConnection(): void;
  markUnavailable(): void;
  markTransportOpen(): void;
  markTransportClosed(): void;
  applySnapshot(
    snapshot: ChatSnapshot,
    replayBacklog?: boolean,
    afterSequence?: number,
  ): void;
  applySnapshotResult(
    snapshots: ChatSnapshot[],
    sequences: Record<string, number>,
    completeCatalog: boolean,
    requestOrder?: number,
    requestEpoch?: number,
  ): void;
  prependHistory(
    chatId: string,
    messages: Message[],
    cursor: string | null,
    hasOlder: boolean,
  ): void;
  clear(): void;
}
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
  applySnapshot: (input, replayBacklog = false, afterSequence = -1) =>
    set((state) => {
      if (state.deletedChats[input.chat.id]) return {};
      let snapshot = { ...input, messages: chronological(input.messages) };
      const history = state.olderHistory[snapshot.chat.id];
      if (history) {
        const ids = new Set(snapshot.messages.map((message) => message.id));
        const older = [
          ...history.messages,
          ...(state.snapshots[snapshot.chat.id]?.messages ?? []),
        ].filter((message) => !ids.has(message.id));
        const unique = [
          ...new Map(older.map((message) => [message.id, message])).values(),
        ];
        snapshot = {
          ...snapshot,
          messages: chronological([...unique, ...snapshot.messages]),
          historyCursor: history.cursor,
          hasOlderHistory: history.hasOlder,
        };
      }
      let sequenceGap = false;
      if (replayBacklog) {
        const afterEvents = (state.runBacklog[snapshot.chat.id] ?? []).filter(
          (event) => event.sequence > afterSequence,
        );
        const runId = snapshot.activeRun?.id ?? afterEvents.at(-1)?.runId;
        const events = afterEvents.filter(
          (event) =>
            event.runId === runId &&
            event.runSequence > (snapshot.activeRun?.sequence ?? -1),
        );
        const first = events[0];
        const dropped = state.runDropped[snapshot.chat.id];
        sequenceGap =
          !!first &&
          !first.replace &&
          !!dropped &&
          dropped.sequence > afterSequence &&
          dropped.runId === runId &&
          dropped.runSequence > (snapshot.activeRun?.sequence ?? -1);
        for (const event of events) {
          if (snapshot.settledRun?.id === event.runId) continue;
          if (
            snapshot.activeRun?.id === event.runId &&
            snapshot.activeRun.sequence >= event.runSequence
          )
            continue;
          snapshot = {
            ...snapshot,
            activeRun: projectRun(snapshot.activeRun, event),
            settledRun: undefined,
          };
        }
      }
      const backlog = { ...state.runBacklog };
      const dropped = { ...state.runDropped };
      delete dropped[snapshot.chat.id];
      delete backlog[snapshot.chat.id];
      return {
        chats: { ...state.chats, [snapshot.chat.id]: snapshot.chat },
        snapshots: { ...state.snapshots, [snapshot.chat.id]: snapshot },
        runBacklog: backlog,
        runDropped: dropped,
        resyncChats: { ...state.resyncChats, [snapshot.chat.id]: sequenceGap },
        ...(snapshot.tools
          ? {
              tools: {
                ...state.tools,
                [snapshot.chat.id]: snapshot.tools.slice(-100),
              },
              toolEventSequences: {
                ...state.toolEventSequences,
                [snapshot.chat.id]: toolWatermarks(
                  snapshot.tools.slice(-100),
                  state.toolEventSequences[snapshot.chat.id] ?? {},
                ),
              },
            }
          : {}),
      };
    }),
  applySnapshotResult: (
    snapshots,
    sequences,
    completeCatalog,
    requestOrder = 0,
    requestEpoch,
  ) => {
    let state = get();
    if (requestEpoch !== undefined && requestEpoch !== state.connectionEpoch)
      return;
    // Only a current-connection authoritative catalog can retire old tombstones.
    if (completeCatalog) {
      const ids = new Set(snapshots.map((snapshot) => snapshot.chat.id));
      const deletedChats = Object.fromEntries(
        Object.entries(state.deletedChats).filter(
          ([id, epoch]) => epoch >= state.connectionEpoch || ids.has(id),
        ),
      );
      set({ deletedChats });
      state = get();
    }
    if (completeCatalog) {
      const catalog = snapshots.flatMap((snapshot) => {
        if (state.deletedChats[snapshot.chat.id]) return [];
        const current = state.chats[snapshot.chat.id];
        if ((state.snapshotReadOrders[snapshot.chat.id] ?? 0) > requestOrder)
          return current ? [current] : [];
        return [
          (state.chatSequences[snapshot.chat.id] ?? -1) ===
          (sequences[snapshot.chat.id] ?? -1)
            ? snapshot.chat
            : (current ?? snapshot.chat),
        ];
      });
      for (const chat of Object.values(state.chats))
        if (
          ((state.chatSequences[chat.id] ?? -1) !==
            (sequences[chat.id] ?? -1) ||
            (state.snapshotReadOrders[chat.id] ?? 0) > requestOrder) &&
          !catalog.some((item) => item.id === chat.id)
        )
          catalog.push(chat);
      get().replaceCatalog(catalog);
    }
    for (const snapshot of snapshots) {
      if (get().deletedChats[snapshot.chat.id]) continue;
      if ((get().snapshotReadOrders[snapshot.chat.id] ?? 0) > requestOrder)
        continue;
      const changed =
        (get().chatSequences[snapshot.chat.id] ?? -1) !==
        (sequences[snapshot.chat.id] ?? -1);
      if (!changed) {
        get().applySnapshot(snapshot);
        set((current) => ({
          snapshotReadOrders: {
            ...current.snapshotReadOrders,
            [snapshot.chat.id]: requestOrder,
          },
        }));
      } else if (
        (get().structuralSequences[snapshot.chat.id] ?? -1) <=
        (sequences[snapshot.chat.id] ?? -1)
      ) {
        const state = get();
        const requestSequence = sequences[snapshot.chat.id] ?? -1;
        const newerTools = (state.tools[snapshot.chat.id] ?? []).filter(
          (tool) =>
            (state.toolEventSequences[snapshot.chat.id]?.[tool.id] ?? -1) >
            requestSequence,
        );
        const ids = new Set(newerTools.map((tool) => tool.id));
        get().applySnapshot(
          {
            ...snapshot,
            ...(snapshot.tools || newerTools.length
              ? {
                  tools: [
                    ...(snapshot.tools ?? []).filter(
                      (tool) => !ids.has(tool.id),
                    ),
                    ...newerTools,
                  ].slice(-100),
                }
              : {}),
          },
          true,
          requestSequence,
        );
        set((current) => ({
          snapshotReadOrders: {
            ...current.snapshotReadOrders,
            [snapshot.chat.id]: requestOrder,
          },
        }));
      }
    }
  },
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
  receiveEvent: (event) => {
    const state = get();
    if (event.type === 'connection.state' && state.generation === null) {
      set({
        generation: event.generation,
        sequence: event.sequence,
        connection: event.state,
      });
      return;
    }
    if (
      event.generation !== state.generation ||
      event.sequence <= state.sequence
    )
      return;
    set({ sequence: event.sequence });
    const chatId =
      event.type === 'conversation.snapshot'
        ? event.snapshot.chat.id
        : event.type === 'conversation.updated'
          ? event.chat.id
          : 'chatId' in event
            ? event.chatId
            : null;
    if (chatId && get().deletedChats[chatId]) return;
    if (chatId)
      set((current) => ({
        chatSequences: { ...current.chatSequences, [chatId]: event.sequence },
      }));
    if (
      chatId &&
      (event.type === 'conversation.snapshot' ||
        event.type === 'conversation.updated' ||
        event.type === 'conversation.deleted')
    )
      set((current) => ({
        structuralSequences: {
          ...current.structuralSequences,
          [chatId]: event.sequence,
        },
      }));
    if (event.type === 'conversation.run.text')
      set((current) => ({
        runEventSequences: {
          ...current.runEventSequences,
          [event.chatId]: event.sequence,
        },
      }));
    switch (event.type) {
      case 'connection.state':
        set({ connection: event.state });
        break;
      case 'conversation.snapshot':
        get().applySnapshot(event.snapshot);
        break;
      case 'conversation.updated':
        get().mergeChat(event.chat);
        break;
      case 'conversation.deleted': {
        get().releaseConfirmedChat(event.chatId);
        break;
      }
      case 'conversation.tool':
        set((current) => {
          const tools = [
            ...(current.tools[event.chatId] ?? []).filter(
              (tool) => tool.id !== event.tool.id,
            ),
            event.tool,
          ].slice(-100);
          return {
            tools: {
              ...current.tools,
              [event.chatId]: tools,
            },
            toolEventSequences: {
              ...current.toolEventSequences,
              [event.chatId]: toolWatermarks(tools, {
                ...current.toolEventSequences[event.chatId],
                [event.tool.id]: event.sequence,
              }),
            },
          };
        });
        break;
      case 'conversation.run.text': {
        const snapshot = get().snapshots[event.chatId];
        if (snapshot?.settledRun?.id === event.runId) return;
        set((current) => {
          const events = event.replace
            ? [event]
            : [...(current.runBacklog[event.chatId] ?? []), event];
          const dropped = { ...current.runDropped };
          if (event.replace) delete dropped[event.chatId];
          let bytes = events.reduce(
            (total, item) => total + item.text.length,
            0,
          );
          while (events.length > 1 && (bytes > 262144 || events.length > 100)) {
            const removed = events.shift();
            if (removed) {
              bytes -= removed.text.length;
              dropped[event.chatId] = removed;
            }
          }
          return {
            runBacklog: { ...current.runBacklog, [event.chatId]: events },
            runDropped: dropped,
          };
        });
        if (!snapshot) return;
        if (
          snapshot.activeRun?.id === event.runId &&
          snapshot.activeRun.sequence >= event.runSequence
        )
          return;
        set((current) => ({
          snapshots: {
            ...current.snapshots,
            [event.chatId]: {
              ...snapshot,
              activeRun: projectRun(snapshot.activeRun, event),
              settledRun: undefined,
            },
          },
        }));
        break;
      }
    }
  },
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
interface CatalogState {
  catalogs: Record<string, ModelCapability[]>;
  load(scope?: string): Promise<ModelCapability[]>;
  clear(): void;
  removeScope(scope: string): void;
}
export const useModelCatalog = create<CatalogState>((set) => ({
  catalogs: {},
  load: async (scope) => {
    const epoch = useChatProjection.getState().connectionEpoch;
    const { data } = await request(
      `/api/models${scope ? `?chatId=${encodeURIComponent(scope)}` : ''}`,
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
export interface Draft {
  text: string;
  attachments: Attachment[];
  revision: number;
}
export const emptyDraft: Draft = { text: '', attachments: [], revision: 0 };
export interface Correction {
  chatId: string;
  messageId: string;
  text: string;
  error: string;
  revision: number;
  draftRevision: number;
}
interface DraftState {
  drafts: Record<string, Draft>;
  corrections: Record<string, Correction>;
  beginCorrection(
    chatId: string,
    messageId: string,
    text: string,
    revision: number,
  ): void;
  acceptCorrection(
    messageId: string,
    draftRevision: number,
    nextRevision: number,
  ): void;
  rebaseCorrection(messageId: string, revision: number): void;
  updateCorrection(messageId: string, text: string): void;
  failCorrection(messageId: string, error: string): void;
  clearCorrection(messageId: string): void;
  setText(id: string, text: string): void;
  setAttachments(id: string, attachments: Attachment[]): void;
  acceptRevision(id: string, revision: number): void;
  clear(): void;
  discardChat(chatId: string): void;
}
export const useDrafts = create<DraftState>((set) => ({
  drafts: {},
  corrections: {},
  beginCorrection: (chatId, messageId, text, revision) =>
    set((state) => ({
      corrections: {
        ...state.corrections,
        [messageId]: state.corrections[messageId] ?? {
          chatId,
          messageId,
          text,
          error: '',
          revision,
          draftRevision: 0,
        },
      },
    })),
  updateCorrection: (messageId, text) =>
    set((state) => {
      const correction = state.corrections[messageId];
      return correction
        ? {
            corrections: {
              ...state.corrections,
              [messageId]: {
                ...correction,
                text,
                draftRevision: correction.draftRevision + 1,
              },
            },
          }
        : {};
    }),
  acceptCorrection: (messageId, draftRevision, nextRevision) =>
    set((state) => {
      const correction = state.corrections[messageId];
      if (!correction) return {};
      const corrections = { ...state.corrections };
      if (correction.draftRevision === draftRevision)
        delete corrections[messageId];
      else
        corrections[messageId] = {
          ...correction,
          revision: nextRevision,
          error: '',
        };
      return { corrections };
    }),
  rebaseCorrection: (messageId, revision) =>
    set((state) => {
      const correction = state.corrections[messageId];
      return correction
        ? {
            corrections: {
              ...state.corrections,
              [messageId]: { ...correction, revision, error: '' },
            },
          }
        : {};
    }),
  failCorrection: (messageId, error) =>
    set((state) => {
      const correction = state.corrections[messageId];
      return correction
        ? {
            corrections: {
              ...state.corrections,
              [messageId]: { ...correction, error },
            },
          }
        : {};
    }),
  clearCorrection: (messageId) =>
    set((state) => {
      const corrections = { ...state.corrections };
      delete corrections[messageId];
      return { corrections };
    }),
  setText: (id, text) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [id]: {
          ...(state.drafts[id] ?? emptyDraft),
          text,
          revision: (state.drafts[id]?.revision ?? 0) + 1,
        },
      },
    })),
  setAttachments: (id, attachments) =>
    set((state) =>
      !useChatProjection.getState().chats[id] ||
      useChatProjection.getState().deletedChats[id]
        ? {}
        : {
            drafts: {
              ...state.drafts,
              [id]: {
                ...(state.drafts[id] ?? emptyDraft),
                attachments,
                revision: (state.drafts[id]?.revision ?? 0) + 1,
              },
            },
          },
    ),
  acceptRevision: (id, revision) =>
    set((state) =>
      state.drafts[id]?.revision === revision
        ? {
            drafts: {
              ...state.drafts,
              [id]: { ...emptyDraft, revision: revision + 1 },
            },
          }
        : {},
    ),
  clear: () => set({ drafts: {}, corrections: {} }),
  discardChat: (chatId) =>
    set((state) => ({
      drafts: withoutKey(state.drafts, chatId),
      corrections: Object.fromEntries(
        Object.entries(state.corrections).filter(
          ([, correction]) => correction.chatId !== chatId,
        ),
      ),
    })),
}));
interface NoticeState {
  notices: { id: string; text: string }[];
  add(text: string): void;
  dismiss(id: string): void;
}
export const useNotices = create<NoticeState>((set) => ({
  notices: [],
  add: (text) =>
    set((state) => ({
      notices: [...state.notices, { id: crypto.randomUUID(), text }].slice(-3),
    })),
  dismiss: (id) =>
    set((state) => ({ notices: state.notices.filter((n) => n.id !== id) })),
}));
