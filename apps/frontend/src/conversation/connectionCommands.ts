import type { ManagerCommand, ManagerResult } from '@messenger/contracts';
export type Send = (
  command: ManagerCommand,
) => Promise<Extract<ManagerResult, { ok: true }>['data']>;
export interface Pending {
  resolve(data: Extract<ManagerResult, { ok: true }>['data']): void;
  reject(error: Error): void;
  timer: number;
  chatSequences: Record<string, number>;
  chatId: string | undefined;
  type: ManagerCommand['type'];
  snapshotOrder: number;
  connectionEpoch: number;
}
export interface ConnectionState {
  socket: { current: WebSocket | null };
  pending: { current: Map<string, Pending> };
  completed: { current: Set<string> };
  snapshotOrder: { current: number };
}
export function failPending(state: ConnectionState) {
  for (const item of state.pending.current.values()) {
    window.clearTimeout(item.timer);
    item.reject(
      new Error(
        'Connection interrupted. Delivery is unconfirmed; your draft is still available. Check the conversation before retrying.',
      ),
    );
  }
  state.pending.current.clear();
}
