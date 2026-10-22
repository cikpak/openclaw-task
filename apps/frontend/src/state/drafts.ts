import { create } from 'zustand';
import type { Attachment } from '@messenger/contracts';
import { useChatProjection } from './projection';
import { withoutKey } from './projectionHelpers';
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
