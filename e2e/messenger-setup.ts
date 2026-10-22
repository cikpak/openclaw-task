import { recordUiFallback } from './aftercase-fallback.js';
import { beginRestartEvidence, restartEvidence } from './restart-evidence.js';
import { test } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import { cleanChats, login } from './helpers.js';
export const reconnectTitle =
  'independent drafts survive navigation and reconnect does not replay accepted work';
export const restartTitle =
  'isolated backend and Gateway restarts keep accepted queue content without replay';
export const expiryTitle =
  'an expired durable session closes an open browser socket and rejects further input';
export let networkFault: {
  blocked: boolean;
  socket?: WebSocketRoute;
  server?: WebSocketRoute;
} | null = null;
export function messengerSetup() {
  test.beforeEach(async ({ page, context }, testInfo) => {
    // Body-level skips run AFTER hooks. These shared lifecycle duplicates must
    // skip before sign-in/cleanup, without consuming the real login rate budget.
    if (testInfo.title === restartTitle)
      test.skip(
        testInfo.project.name !== 'desktop',
        'Restart boundary is shared by both responsive layouts.',
      );
    if (testInfo.title === expiryTitle)
      test.skip(
        testInfo.project.name !== 'desktop',
        'The same session/socket boundary serves both layouts.',
      );
    if (testInfo.title === restartTitle) beginRestartEvidence(page);
    networkFault = null;
    if (testInfo.title === reconnectTitle) {
      const fault: {
        blocked: boolean;
        socket?: WebSocketRoute;
        server?: WebSocketRoute;
      } = {
        blocked: false,
      };
      networkFault = fault;
      await context.routeWebSocket('**/ws/conversation?*', (route) => {
        if (fault.blocked) {
          void route
            .close({ code: 1012, reason: 'Acceptance transport interruption' })
            .catch(() => {});
        } else {
          // Forward every command/event to the real backend; inject only closure.
          const server = route.connectToServer();
          route.onMessage((message) => {
            const frame = JSON.parse(String(message)) as { type: string };
            if (
              frame.type === 'chat.create' ||
              frame.type === 'conversation.recent.request'
            ) {
              fault.socket = route;
              fault.server = server;
            }
            server.send(message);
          });
        }
      });
    }
    await login(page);
    await cleanChats(page);
    await page.reload();
  });
  test.afterEach(async () => {
    const testInfo = test.info();
    if (testInfo.title === restartTitle && testInfo.project.name === 'desktop')
      await restartEvidence?.save(
        `.context/restart-structure-${testInfo.project.name}.json`,
      );
    if (
      process.env.ACCEPTANCE_VERIFY_FALLBACK === '1' &&
      testInfo.title ===
        'steering ownership, abort and cancel-work settings preserve the other chat' &&
      testInfo.status === 'passed'
    )
      await recordUiFallback(testInfo);
  });
}
