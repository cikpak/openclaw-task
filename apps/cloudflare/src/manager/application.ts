import type { ManagerCommand, ManagerResultData } from '@messenger/contracts';
import {
  ConflictError,
  GatewayUnavailableError,
} from '../../../backend/src/errors.js';
import type { Store } from '../../../backend/src/storage/store.js';
import {
  ManagerTransport,
  type ManagerHandlers,
} from '../../../backend/src/transport/manager.js';
import type { ManagerAuthorization } from './authorization.js';
import { acceptCreation, acceptMessage } from './acceptance.js';
import { types } from './command-types.js';
import { CachedCommands } from './cached-commands.js';
import { runtimeCommand } from './runtime-commands.js';
import type { Grant, ManagerEngine } from './types.js';
import type { ManagerFiles } from '../files/service.js';
import type { BrowserBoundary } from '../files/boundary.js';
import { restoreCanonicalCommand } from '../files/canonical.js';
import { storedAcceptance } from './acceptance.js';
import { validateCachedCreation } from './creation-validation.js';
import { readPreferences } from '../../../backend/src/chats/preferences.js';

export class ManagerApplication {
  constructor(
    private readonly store: Store,
    private readonly authorization: ManagerAuthorization,
    private readonly engine: ManagerEngine | undefined,
    private readonly background: (work: Promise<unknown>) => void,
    private readonly files?: ManagerFiles,
    private readonly boundary?: BrowserBoundary,
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS manager_execution_inputs (id TEXT PRIMARY KEY, json TEXT NOT NULL)',
    );
  }
  private execution(command: ManagerCommand): ManagerCommand {
    if (!this.boundary) return command;
    const previous = this.store.db
      .prepare('SELECT json FROM manager_execution_inputs WHERE id = ?')
      .get(command.commandId) as { json: string } | undefined;
    if (previous) return JSON.parse(previous.json) as ManagerCommand;
    const canonical = restoreCanonicalCommand(
      command,
      this.store,
      this.boundary,
    );
    if (canonical !== command)
      this.store.db
        .prepare('INSERT INTO manager_execution_inputs VALUES (?, ?)')
        .run(command.commandId, JSON.stringify(canonical));
    return canonical;
  }
  private safeAcceptance(
    commandId: string,
    result: ManagerResultData,
  ): ManagerResultData {
    const safe = this.boundary?.project(result) ?? result;
    this.store.db
      .prepare(
        'INSERT INTO manager_results VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
      )
      .run(commandId, JSON.stringify(safe));
    return safe;
  }
  transport(grant: Grant): ManagerTransport {
    const handlers = Object.fromEntries(
      Object.keys(types).map((type) => [
        type,
        (command: ManagerCommand) => this.execute(command, grant),
      ]),
    ) as ManagerHandlers;
    return new ManagerTransport(
      { authorize: (command) => this.authorization.authorize(command, grant) },
      handlers,
    );
  }
  private wake(command: ManagerCommand): void {
    if (this.engine)
      this.background(Promise.resolve().then(() => this.engine!.wake(command)));
  }
  private async execute(
    command: ManagerCommand,
    grant: Grant,
  ): Promise<ManagerResultData> {
    const { store, engine } = this;
    const { accountId } = grant;
    this.authorization.assertLive(grant);
    const accepted = storedAcceptance(store, command.commandId);
    if (accepted) {
      const chatId = 'chatId' in command ? command.chatId : accepted.chat?.id;
      if (
        (command.type === 'conversation.message.send' ||
          command.type === 'chat.create') &&
        chatId &&
        (store.pending(chatId).length ||
          store.getChat(chatId).status === 'creating')
      )
        this.wake(command);
      return accepted;
    }
    const canonical = this.execution(command);
    const cached = new CachedCommands(store, this.authorization, engine).read(
      command,
      accountId,
    );
    if (cached) return cached;
    const fileResult = await this.files?.command(command, grant);
    if (fileResult) return fileResult;
    if (
      command.type === 'conversation.message.send' ||
      command.type === 'chat.create'
    ) {
      if (canonical.type === 'chat.create')
        validateCachedCreation(store, canonical.settings);
      const uploads =
        command.type === 'chat.create'
          ? command.initialMessage?.uploadIds
          : command.uploadIds;
      if (uploads?.length && !this.files && !engine?.prepareAttachments)
        throw new GatewayUnavailableError();
      const attachments = uploads?.length
        ? this.files
          ? await this.files.uploads.prepare(command, accountId)
          : await engine!.prepareAttachments!(command)
        : [];
      this.authorization.assertLive(grant);
      const data = store.db.transaction(() => {
        const previous = store.commandRequest(command.commandId);
        if (previous && previous !== JSON.stringify(command))
          throw new ConflictError(
            'COMMAND_ID_REUSED',
            'This command identity was already used with different values.',
          );
        this.authorization.claim(
          'command',
          command.commandId,
          accountId,
          'chatId' in command ? command.chatId : undefined,
        );
        if (command.type === 'conversation.message.send') {
          const steer =
            (command.behavior ?? readPreferences(store).busySendBehavior) ===
            'steer';
          const target =
            steer && engine?.gateway.ready
              ? engine.service.cachedSnapshot(command.chatId).activeRun?.id
              : undefined;
          const result = acceptMessage(store, command, attachments, target);
          this.files?.uploads.commitReferences(
            command,
            command.chatId,
            accountId,
          );
          return this.safeAcceptance(command.commandId, result);
        }
        const { type: _type, ...input } = canonical as Extract<
          ManagerCommand,
          { type: 'chat.create' }
        >;
        void _type;
        store.saveCommandRequest(command.commandId, JSON.stringify(command));
        const result = acceptCreation(
          store,
          this.authorization,
          accountId,
          input,
          attachments,
        );
        if (result.chat)
          this.files?.uploads.commitReferences(
            command,
            result.chat.id,
            accountId,
          );
        return this.safeAcceptance(command.commandId, result);
      })();
      this.wake(command);
      return data;
    }
    if (!engine) throw new GatewayUnavailableError();
    const extended = await engine.handle?.(canonical, accountId);
    if (extended) return this.safeAcceptance(command.commandId, extended);
    await engine.wake(command);
    await this.authorization.authorize(command, grant);
    try {
      const result = await runtimeCommand(canonical, store, engine);
      if (
        canonical !== command ||
        ![
          'models.list',
          'conversation.history.request',
          'chat.settings.get',
        ].includes(command.type)
      )
        this.safeAcceptance(command.commandId, result);
      return result;
    } finally {
      if (canonical !== command && store.commandRequest(command.commandId))
        store.saveCommandRequest(command.commandId, JSON.stringify(command));
    }
  }
}
