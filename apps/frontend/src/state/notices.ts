import { create } from 'zustand';
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
