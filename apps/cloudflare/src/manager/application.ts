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

export class ManagerApplication {
  constructor(
    private readonly store: Store,
    private readonly authorization: ManagerAuthorization,
    private readonly engine: ManagerEngine | undefined,
    private readonly background: (work: Promise<unknown>) => void,
  ) {}
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
    const cached = new CachedCommands(store, this.authorization, engine).read(
      command,
      accountId,
    );
    if (cached) return cached;
    if (
      command.type === 'conversation.message.send' ||
      command.type === 'chat.create'
    ) {
      const uploads =
        command.type === 'chat.create'
          ? command.initialMessage?.uploadIds
          : command.uploadIds;
      if (uploads?.length && !engine?.prepareAttachments)
        throw new GatewayUnavailableError();
      const attachments = uploads?.length
        ? await engine!.prepareAttachments!(command)
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
        if (command.type === 'conversation.message.send')
          return acceptMessage(store, command, attachments);
        const { type: _type, ...input } = command;
        void _type;
        store.saveCommandRequest(command.commandId, JSON.stringify(command));
        return acceptCreation(
          store,
          this.authorization,
          accountId,
          input,
          attachments,
        );
      })();
      this.wake(command);
      return data;
    }
    if (!engine) throw new GatewayUnavailableError();
    const extended = await engine.handle?.(command, accountId);
    if (extended) return extended;
    await engine.wake(command);
    await this.authorization.authorize(command, grant);
    return runtimeCommand(command, store, engine);
  }
}
