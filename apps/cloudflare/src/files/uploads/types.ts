import type {
  GatewayAttachment,
  GatewayMapping,
} from '../../../../backend/src/gateway/types.js';
export interface UploadRecord {
  id: string;
  accountId: string;
  chatId: string | null;
  name: string;
  mimeType: string;
  size: number;
  key: string;
  sha256: string;
  status: 'staging' | 'complete' | 'deleting';
  received: number;
  expiresAt: number;
}
export interface UploadOwnership {
  claim(kind: string, id: string, accountId: string, chatId?: string): void;
  require(kind: string, id: string, accountId: string, chatId?: string): void;
}
export type UploadHandoff = (
  mapping: GatewayMapping,
  uploads: (UploadRecord & { url: string })[],
) => Promise<GatewayAttachment[]>;
export interface UploadChunk {
  offset: number;
  size: number;
  sha256: string;
  key: string;
}
