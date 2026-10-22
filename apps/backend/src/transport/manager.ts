import type {
  ManagerCommand,
  ManagerResult,
  ManagerResultData,
} from '@messenger/contracts';
import { ApplicationError, ValidationError, toProblem } from '../errors.js';
import { managerCommandSchema } from './manager-schema.js';

export type ManagerHandlers = {
  [Command in ManagerCommand as Command['type']]: (
    command: Command,
  ) => Promise<ManagerResultData>;
};
export interface ManagerAuthorization {
  /** Check the session/grant and every referenced chat/upload/file before each operation. */
  authorize(command: ManagerCommand): Promise<void>;
}
/** Platform adapters own framing and durable mutation transactions; this owns ingress. */
export class ManagerTransport {
  constructor(
    private readonly authorization: ManagerAuthorization,
    private readonly handlers: ManagerHandlers,
  ) {}

  async dispatch(
    value: unknown,
    correlationId: string,
  ): Promise<ManagerResult> {
    const parsed = managerCommandSchema.safeParse(value);
    if (!parsed.success)
      return {
        type: 'command.result',
        commandId: 'invalid',
        ok: false,
        error: toProblem(new ValidationError(), correlationId),
      };
    const command = parsed.data;
    try {
      await this.authorization.authorize(command);
      const handler = this.handlers[command.type] as (
        command: ManagerCommand,
      ) => Promise<ManagerResultData>;
      if (!handler)
        throw new ApplicationError(
          400,
          'UNKNOWN_COMMAND',
          'The operation is not supported.',
        );
      return {
        type: 'command.result',
        commandId: command.commandId,
        ok: true,
        data: await handler(command),
      };
    } catch (error) {
      // ApplicationError details are controlled text. Raw upstream exceptions are never echoed.
      return {
        type: 'command.result',
        commandId: command.commandId,
        ok: false,
        error: toProblem(error, correlationId),
      };
    }
  }
}
