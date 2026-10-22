import type { Page } from '@playwright/test';
import type {
  ManagerCommand,
  ManagerResult,
  ManagerResultData,
  ProblemDetails,
} from '@messenger/contracts';

type FixtureReply = ManagerResultData | { error: ProblemDetails } | undefined;
/** Mock application commands at their actual transport boundary; auth stays real. */
export async function mockManager(
  page: Page,
  reply: (command: ManagerCommand) => Promise<FixtureReply>,
  transform?: (
    result: ManagerResult,
    command: ManagerCommand | undefined,
  ) => ManagerResult,
) {
  await page.routeWebSocket('**/ws/conversation?*', (socket) => {
    const server = socket.connectToServer();
    const commands = new Map<string, ManagerCommand>();
    socket.onMessage(async (message) => {
      const command = JSON.parse(String(message)) as ManagerCommand;
      commands.set(command.commandId, command);
      const fixture = await reply(command);
      if (fixture === undefined) {
        server.send(message);
        return;
      }
      socket.send(
        JSON.stringify(
          'error' in fixture
            ? {
                type: 'command.result',
                commandId: command.commandId,
                ok: false,
                error: fixture.error,
              }
            : {
                type: 'command.result',
                commandId: command.commandId,
                ok: true,
                data: fixture,
              },
        ),
      );
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as ManagerResult;
      socket.send(
        transform && frame.type === 'command.result'
          ? JSON.stringify(transform(frame, commands.get(frame.commandId)))
          : message,
      );
    });
  });
}
