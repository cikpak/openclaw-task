import type { Store } from '../../../backend/src/storage/store.js';
import type { ChatService } from '../../../backend/src/chats/service.js';
import type { Gateway } from '../../../backend/src/gateway/types.js';
import type {
  ManagerCommand,
  ConversationEvent,
  ManagerResultData,
  Attachment,
} from '@messenger/contracts';

export interface ManagerEnv {
  BACKEND: Fetcher;
  MANAGERS: DurableObjectNamespace;
  APP_ORIGIN: string;
  MANAGER_ID?: string;
  ENGINE_IDLE_SECONDS?: string;
  DEFAULT_MODEL?: string;
  RECOVERY_BUCKET?: R2Bucket;
  R2_BUCKET_NAME?: string;
  R2_ORIGIN?: string;
  LOCAL_R2_EMULATOR?: '1';
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}
export interface Grant {
  id: string;
  sessionId: string;
  accountId: string;
  managerId: string;
  expiresAt: number;
}
export interface SocketAdmission {
  grant: Grant;
  renewAt: number;
}
export interface DeadlineScheduler {
  set(name: string, deadline: number | null): Promise<void>;
}
/** Phase-three integration: authorization never controls accepted engine work. */
export interface ManagerEngine {
  service: ChatService;
  gateway: Gateway;
  wake(reason: ManagerCommand): Promise<void>;
  tick(): Promise<void>;
  deadline(): number | null;
  prepareAttachments?(command: ManagerCommand): Promise<Attachment[]>;
  handle?(
    command: ManagerCommand,
    accountId: string,
  ): Promise<ManagerResultData | undefined>;
}
export interface EngineContext {
  state: DurableObjectState;
  env: ManagerEnv;
  store: Store;
  publish(event: ConversationEvent): void;
  schedule: DeadlineScheduler;
}
