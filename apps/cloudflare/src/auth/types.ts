/// <reference types="@cloudflare/workers-types" />

export interface BackendEnv {
  AUTH_DB: D1Database;
  MANAGER?: Fetcher;
  APP_ORIGIN: string;
  APP_USERNAME: string;
  APP_PASSWORD_HASH: string;
  SESSION_TTL_SECONDS?: string;
}

export interface Session {
  id: string;
  token_hash: string;
  account_id: string;
  manager_id: string;
  expires_at: number;
}

export interface Grant {
  id: string;
  sessionId: string;
  accountId: string;
  managerId: string;
  expiresAt: number;
}

export const ACCOUNT_ID = 'owner';
export const MANAGER_ID = 'primary';
export const COOKIE_NAME = '__Host-messenger_session';
export const TICKET_LIFETIME = 60_000;
export const GRANT_LIFETIME = 15 * 60_000;
