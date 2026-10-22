import type { ManagerCommand } from '@messenger/contracts';
import { z } from 'zod';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
} from '../../../backend/src/errors.js';
import type { Store } from '../../../backend/src/storage/store.js';
import type { Grant, ManagerEnv } from './types.js';

const grantSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  accountId: z.string().min(1),
  managerId: z.string().min(1),
  expiresAt: z.number().int().positive(),
});
export class ManagerAuthorization {
  constructor(
    private readonly env: ManagerEnv,
    private readonly store: Store,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS manager_resources (
      kind TEXT NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL, chat_id TEXT,
      PRIMARY KEY(kind, id));
      CREATE TABLE IF NOT EXISTS manager_revoked_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS manager_results (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_command_inputs (id TEXT PRIMARY KEY, json TEXT NOT NULL);`);
  }
  get managerId(): string {
    return this.env.MANAGER_ID ?? 'primary';
  }
  revoked(sessionId: string): boolean {
    return !!this.store.db
      .prepare('SELECT id FROM manager_revoked_sessions WHERE id = ?')
      .get(sessionId);
  }
  revoke(sessionId: string): void {
    this.store.db
      .prepare('INSERT OR IGNORE INTO manager_revoked_sessions VALUES (?)')
      .run(sessionId);
  }
  assertLive(grant: Grant): void {
    if (grant.expiresAt <= Date.now() || this.revoked(grant.sessionId))
      throw new AuthenticationError();
  }
  async grant(
    operation: 'consume' | 'check' | 'renew',
    input: Record<string, string>,
  ): Promise<Grant> {
    const response = await this.env.BACKEND.fetch(
      `https://backend/internal/auth/${operation}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, managerId: this.managerId }),
      },
    );
    if (!response.ok) throw new AuthenticationError();
    const { grant } = z
      .object({ grant: grantSchema })
      .parse(await response.json());
    if (
      grant.managerId !== this.managerId ||
      grant.expiresAt <= Date.now() ||
      this.revoked(grant.sessionId)
    )
      throw new AuthenticationError();
    return grant;
  }
  claim(kind: string, id: string, accountId: string, chatId?: string): void {
    this.store.db
      .prepare('INSERT OR IGNORE INTO manager_resources VALUES (?, ?, ?, ?)')
      .run(kind, id, accountId, chatId ?? null);
    this.require(kind, id, accountId, chatId);
  }
  owns(kind: string, id: string, accountId: string, chatId?: string): boolean {
    const row = this.store.db
      .prepare(
        'SELECT account_id, chat_id FROM manager_resources WHERE kind = ? AND id = ?',
      )
      .get(kind, id) as
      { account_id: string; chat_id: string | null } | undefined;
    return (
      row?.account_id === accountId &&
      (!chatId || !row.chat_id || row.chat_id === chatId)
    );
  }
  require(kind: string, id: string, accountId: string, chatId?: string): void {
    if (!this.owns(kind, id, accountId, chatId)) throw new NotFoundError();
  }
  async authorize(command: ManagerCommand, admission: Grant): Promise<void> {
    this.assertLive(admission);
    const current = await this.grant('check', { grantId: admission.id });
    if (
      current.sessionId !== admission.sessionId ||
      current.accountId !== admission.accountId
    )
      throw new AuthenticationError();
    if ('chatId' in command && command.chatId)
      this.require('chat', command.chatId, current.accountId);
    if ('uploadId' in command)
      this.require('upload', command.uploadId, current.accountId);
    const uploads =
      'uploadIds' in command
        ? command.uploadIds
        : command.type === 'chat.create'
          ? command.initialMessage?.uploadIds
          : undefined;
    for (const id of uploads ?? [])
      this.require(
        'upload',
        id,
        current.accountId,
        'chatId' in command ? command.chatId : undefined,
      );
    if ('fileId' in command)
      this.require(
        'file',
        command.fileId,
        current.accountId,
        'chatId' in command ? command.chatId : undefined,
      );
    if ('receiptCommandId' in command)
      this.require('command', command.receiptCommandId, current.accountId);
    if (command.type === 'chat.create') {
      const existing = this.store.creationCommand(command.commandId);
      if (existing) this.require('chat', existing.chatId, current.accountId);
    }
    this.store.db.transaction(() => {
      this.claim(
        'command',
        command.commandId,
        current.accountId,
        'chatId' in command ? command.chatId : undefined,
      );
      const previous = this.store.db
        .prepare('SELECT json FROM manager_command_inputs WHERE id = ?')
        .get(command.commandId) as { json: string } | undefined;
      if (previous && previous.json !== JSON.stringify(command))
        throw new ConflictError(
          'COMMAND_ID_REUSED',
          'This command identity was already used with different values.',
        );
      const native = this.store.commandRequest(command.commandId);
      if (native && native !== JSON.stringify(command))
        throw new ConflictError(
          'COMMAND_ID_REUSED',
          'This command identity was already used with different values.',
        );
      this.store.db
        .prepare('INSERT OR IGNORE INTO manager_command_inputs VALUES (?, ?)')
        .run(command.commandId, JSON.stringify(command));
    })();
  }
}
