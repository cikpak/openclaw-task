import type {
  ActiveRun,
  ChatSnapshot,
  ConversationEvent,
  PendingMessage,
  SettingsOperation,
} from '@messenger/contracts';
import type { Gateway } from '../gateway/types.js';
import type { ChatRecord, Store } from '../storage/store.js';
import { SettledRunProjection } from './projection.js';
import type { MessageMedia } from './queue.js';
import { TitleCoordinator } from './titles.js';

import { changed, withLock } from './service-runtime.js';
export type EventPayload<T> = T extends ConversationEvent
  ? Omit<T, 'generation' | 'sequence'>
  : never;
export type DispatchClaim =
  | { kind: 'delete'; chat: ChatRecord }
  | { kind: 'settings'; chat: ChatRecord; operation: SettingsOperation }
  | { kind: 'message'; item: PendingMessage; steerTarget?: string }
  | null;

export class ServiceState {
  readonly generation = crypto.randomUUID();
  sequence = 0;
  connectionEpoch = 0;
  closed = false;
  readonly listeners = new Set<(event: ConversationEvent) => void>();
  readonly locks = new Map<string, Promise<void>>();
  readonly driving = new Map<string, Promise<void>>();
  readonly steering = new Set<Promise<void>>();
  readonly uninvokedSubmissions = new Map<
    string,
    { revision: number; submissionId: string; epoch: number }
  >();
  readonly driveRequested = new Set<string>();
  readonly stateEpochs = new Map<string, number>();
  readonly readEpochs = new Map<string, number>();
  readonly streams = new Map<string, ActiveRun>();
  readonly settled = new SettledRunProjection();
  readonly runSequences = new Map<string, number>();
  readonly terminalRuns = new Set<string>();
  unsubscribe: () => void = () => {};
  readonly titles: TitleCoordinator;
  recoveryTimer?: ReturnType<typeof setInterval>;
  readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly refreshRetries = new Map<string, ReturnType<typeof setTimeout>>();
  reconciliation: Promise<void> | null = null;
  reconciliationRequested = false;
  tombstoneOffset = 0;
  reconciled = false;
  constructor(
    readonly store: Store,
    readonly gateway: Gateway,
    readonly media?: MessageMedia,
    readonly projectSnapshot?: (snapshot: ChatSnapshot) => ChatSnapshot,
  ) {
    this.titles = new TitleCoordinator(
      store,
      gateway,
      (id) => changed(this, id, false),
      <T>(id: string, work: () => Promise<T>) => withLock(this, id, work),
    );
  }
}
