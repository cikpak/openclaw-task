import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { devices, expect, request, test } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import type { ChatSummary } from '@messenger/contracts';
import {
  seedWorkspaceImage,
  IMAGE_FIXTURE_BYTES,
} from '../scripts/seed-media-fixture.mjs';
import {
  catalog,
  cleanChats,
  createChat,
  goChat,
  idle,
  login,
  mobileTarget,
  send,
  transcript,
} from './helpers.js';

const reconnectTitle =
  'independent drafts survive navigation and reconnect does not replay accepted work';
const restartTitle =
  'isolated backend and Gateway restarts keep accepted queue content without replay';
const expiryTitle =
  'an expired durable session closes an open browser socket and rejects further input';
let networkFault: {
  blocked: boolean;
  socket?: WebSocketRoute;
  server?: WebSocketRoute;
} | null = null;
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
    await context.routeWebSocket('**/ws/conversation', (route) => {
      if (fault.blocked) {
        void route
          .close({ code: 1012, reason: 'Acceptance transport interruption' })
          .catch(() => {});
      } else {
        // Forward every command/event to the real backend; inject only closure.
        fault.socket = route;
        fault.server = route.connectToServer();
      }
    });
  }
  await login(page);
  await cleanChats(page.request);
  await page.reload();
});

test('complete creation, streamed message, settings, rename and deletion journey', async ({
  page,
}, testInfo) => {
  await createChat(page, 'Research partner', 'A first question');
  await idle(page);
  await expect(
    transcript(page).filter({ hasText: 'A first question' }),
  ).toHaveCount(1);
  await expect(
    transcript(page).filter({ hasText: 'Real Gateway integration response.' }),
  ).toHaveCount(1);
  await send(page, 'A follow-up question');
  await idle(page);
  await expect(
    transcript(page).filter({ hasText: 'A follow-up question' }),
  ).toHaveCount(1);
  await expect(
    transcript(page).filter({ hasText: 'Real Gateway integration response.' }),
  ).toHaveCount(2);
  await mkdir('.context/screenshots', { recursive: true });
  await page.screenshot({
    path: `.context/screenshots/messenger-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Agent settings', exact: true })
    .click();
  const settings = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(
    settings.getByRole('combobox', { name: 'Model', exact: true }),
  ).toHaveAttribute('data-value', 'mock/test-model');
  await settings.getByLabel('Conversation name').fill('Renamed research');
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect(settings).not.toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Renamed research', exact: true }),
  ).toBeVisible();
  await mobileTarget(
    page,
    page.getByRole('button', { name: 'Dismiss notification' }).first(),
  );
  await page
    .getByRole('button', { name: 'Agent settings', exact: true })
    .click();
  await settings
    .getByRole('button', { name: 'Delete conversation…', exact: true })
    .click();
  const confirmDelete = settings.getByRole('button', {
    name: 'Confirm deletion',
    exact: true,
  });
  const deletionReply = () =>
    page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname.startsWith('/api/chats/'),
    );
  let [deletion] = await Promise.all([deletionReply(), confirmDelete.click()]);
  if (deletion.status() === 412) {
    // The preceding accepted settings operation can advance the version AFTER
    // this panel's fresh read. A conflict requires an explicit user refresh and
    // another confirmation; never automatically retry a destructive request.
    await expect(settings.getByRole('alert')).toContainText(
      'This resource changed. Reload before saving.',
    );
    await settings
      .getByRole('button', {
        name: 'Refresh latest values and models, keep my edits',
      })
      .click();
    await expect(
      settings.getByText('Latest saved values:', { exact: false }),
    ).toContainText('Renamed research');
    [deletion] = await Promise.all([deletionReply(), confirmDelete.click()]);
  }
  expect([202, 204]).toContain(deletion.status());
  await expect(page).toHaveURL(/\/$/u);
  await expect.poll(async () => (await catalog(page.request)).length).toBe(0);
});

test('compact monochrome styling retains readable text and responsive controls', async ({
  page,
}, testInfo) => {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() =>
      Array.from(document.fonts).some(
        (font) => font.family === 'Inter Variable' && font.status === 'loaded',
      ),
    ),
    'Inter must load locally, not just appear in the fallback font list',
  ).toBe(true);
  const brand = page.getByRole('link', { name: /openclaw/u });
  await expect(brand).toHaveCSS('color', 'rgb(0, 0, 0)');
  await expect(page.locator('aside')).toHaveCSS(
    'background-color',
    'rgb(237, 237, 237)',
  );
  await page.getByRole('button', { name: 'New conversation' }).click();
  const creation = page.getByRole('dialog', { name: 'Start a conversation' });
  await expect(creation.getByRole('heading')).toHaveCSS('font-size', '20px');
  await expect(creation.getByRole('button', { name: 'Continue' })).toHaveCSS(
    'background-color',
    'rgb(23, 23, 23)',
  );
  await creation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await createChat(page, 'Design check');
  const composer = page.getByRole('textbox', { name: 'Message Design check' });
  await composer.fill('A compact workspace, focused on the conversation.');
  await expect(composer).toHaveCSS('font-size', '16px');
  await expect(
    page.getByRole('heading', { name: 'Design check', exact: true }),
  ).toHaveCSS(
    'font-size',
    testInfo.project.name === 'mobile' ? '16px' : '18px',
  );
  const sendButton = page.getByRole('button', { name: 'Send message' });
  await expect(sendButton).toHaveCSS('background-color', 'rgb(23, 23, 23)');
  const box = await sendButton.boundingBox();
  expect(box).not.toBeNull();
  if (testInfo.project.name === 'desktop') {
    expect(box?.height).toBeLessThanOrEqual(36);
    const composerBox = await composer.locator('..').boundingBox();
    expect(composerBox?.height, 'Composer stays compact').toBeLessThanOrEqual(
      150,
    );
    await expect(brand).toHaveCSS('font-size', '24px');
  } else {
    await mobileTarget(page, sendButton);
  }
  const fitsViewport = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
  expect(await fitsViewport(), 'No horizontal page overflow').toBe(true);
  await mkdir('.context/screenshots', { recursive: true });
  await page.screenshot({
    path: `.context/screenshots/monochrome-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Agent settings', exact: true })
    .click();
  const settings = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(
    settings.getByRole('heading', { name: 'Agent settings' }),
  ).toHaveCSS('font-size', '22px');
  await expect(settings.getByLabel('Conversation name')).toHaveCSS(
    'font-size',
    '16px',
  );
  expect(await fitsViewport()).toBe(true);
  await page.screenshot({
    path: `.context/screenshots/monochrome-settings-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await settings.getByRole('button', { name: /Close/u }).click();
  await expect(settings).not.toBeVisible();
  await expect(page.locator('form')).toHaveCount(1);
  if (testInfo.project.name === 'mobile') {
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await fitsViewport(), 'Small-phone layout fits').toBe(true);
    await mobileTarget(page, sendButton);
    await page.setViewportSize({ width: 812, height: 375 });
    expect(await fitsViewport(), 'Landscape layout fits').toBe(true);
    await expect(sendButton).toBeVisible();
  }
});

test(reconnectTitle, async ({ page, context }) => {
  const first = await createChat(page, 'First space');
  const second = await createChat(page, 'Second space');
  await page
    .getByRole('textbox', { name: 'Message Second space', exact: true })
    .fill('Second draft');
  await goChat(page, first);
  await page
    .getByRole('textbox', { name: 'Message First space', exact: true })
    .fill('First draft');
  await goChat(page, second);
  await expect(
    page.getByRole('textbox', { name: 'Message Second space', exact: true }),
  ).toHaveValue('Second draft');
  await goChat(page, first);
  await expect(
    page.getByRole('textbox', { name: 'Message First space', exact: true }),
  ).toHaveValue('First draft');
  await send(page, 'LONG_RESPONSE_FIXTURE accepted once');
  await page
    .getByRole('textbox', { name: 'Message First space', exact: true })
    .fill('Reconnect draft');
  await context.setOffline(true);
  if (!networkFault?.socket)
    throw new Error(
      'The real browser/backend socket must be connected before interruption',
    );
  networkFault.blocked = true;
  await networkFault.socket.close({
    code: 1012,
    reason: 'Acceptance transport interruption',
  });
  await networkFault.server?.close({
    code: 1012,
    reason: 'Acceptance transport interruption',
  });
  await expect(
    page.getByText('Waiting for the server connection. Your draft is kept.'),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Message First space', exact: true }),
  ).toHaveValue('Reconnect draft');
  networkFault.blocked = false;
  await context.setOffline(false);
  await idle(page);
  await expect(
    transcript(page).filter({ hasText: 'LONG_RESPONSE_FIXTURE accepted once' }),
  ).toHaveCount(1);
  await expect(
    transcript(page).filter({ hasText: 'Real Gateway integration response.' }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('textbox', { name: 'Message First space', exact: true }),
  ).toHaveValue('Reconnect draft');
  await goChat(page, second);
  await expect(
    page.getByRole('textbox', { name: 'Message Second space', exact: true }),
  ).toHaveValue('Second draft');
  await expect(transcript(page)).toHaveCount(0);
});

test('queued correction keeps its position, cancellation and idle settings affect only its chat', async ({
  page,
}) => {
  const untouched = await createChat(page, 'Untouched space');
  await createChat(page, 'Queue space');
  await send(page, 'LONG_RESPONSE_FIXTURE hold current work');
  await expect(
    page.getByText('Agent is working', { exact: false }),
  ).toBeVisible();
  await mobileTarget(
    page,
    page.getByRole('button', { name: 'Stop this run', exact: true }),
  );
  await mobileTarget(
    page,
    page.getByRole('combobox', { name: 'Send behavior', exact: true }),
  );
  await send(page, 'First queued item');
  await send(page, 'Second queued item');
  const first = page.getByRole('article', {
    name: 'Queued message 2',
    exact: true,
  });
  const second = page.getByRole('article', {
    name: 'Queued message 3',
    exact: true,
  });
  await expect(first).toContainText('First queued item');
  await expect(second).toContainText('Second queued item');
  await first.getByRole('button', { name: 'Edit', exact: true }).click();
  await first.getByLabel('Correction').fill('Corrected first item');
  await first.getByRole('button', { name: 'Save correction' }).click();
  await expect(first).toContainText('Corrected first item');
  await expect(second).toContainText('Second queued item');
  await second.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(second).not.toBeVisible();
  await page
    .getByRole('button', { name: 'Agent settings', exact: true })
    .click();
  const settings = page.getByRole('dialog', { name: 'Agent settings' });
  const responseStyle = settings.getByRole('combobox', {
    name: 'Response style',
    exact: true,
  });
  await expect(responseStyle).toBeEnabled();
  const save = settings.getByRole('button', { name: 'Save changes' });
  await expect(save).toBeDisabled();
  await responseStyle.click();
  await settings.getByRole('option', { name: 'Concise', exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await settings
    .getByRole('button', { name: 'Apply when all work is idle' })
    .click();
  await expect(
    page.getByText('Applies after all active and queued work finishes.', {
      exact: false,
    }),
  ).toBeVisible();
  await mobileTarget(
    page,
    page.getByRole('button', { name: 'Dismiss notification' }).first(),
  );
  await page.reload();
  await expect(
    page.getByText('Applies after all active and queued work finishes.', {
      exact: false,
    }),
  ).toBeVisible();
  await idle(page);
  await expect(
    transcript(page).filter({ hasText: 'Corrected first item' }),
  ).toHaveCount(1);
  await expect(
    transcript(page).filter({ hasText: 'Second queued item' }),
  ).toHaveCount(0);
  await expect(
    transcript(page).filter({ hasText: 'Real Gateway integration response.' }),
  ).toHaveCount(2);
  await expect(
    page.getByText('Applies after all active and queued work finishes.', {
      exact: false,
    }),
  ).not.toBeVisible();
  await page
    .getByRole('button', { name: 'Agent settings', exact: true })
    .click();
  await expect(responseStyle).toBeEnabled();
  await expect(responseStyle).toHaveAttribute('data-value', 'concise');
  await expect(save).toBeDisabled();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(settings).not.toBeVisible();
  await goChat(page, untouched);
  await expect(transcript(page)).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Untouched space', exact: true }),
  ).toBeVisible();
});

test('steering ownership, abort and cancel-work settings preserve the other chat', async ({
  page,
}) => {
  const other = await createChat(page, 'Independent space');
  const target = await createChat(page, 'Control space');
  await page.goto('/settings');
  await page.getByLabel('Default send behavior').click();
  await page
    .getByRole('option', { name: 'Steer · guide the current run', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(
    page.getByText('Preferences saved.', { exact: true }),
  ).toBeVisible();
  await page.goto(`/chat/${target}`);
  await send(page, 'LONG_RESPONSE_FIXTURE steering target');
  await expect(page.getByLabel('Send behavior')).toHaveAttribute(
    'data-value',
    'steer',
  );
  await page.getByLabel('Send behavior').click();
  await page.getByRole('option', { name: 'Queue next', exact: true }).click();
  await send(page, 'Guide this work instead');
  const queued = page
    .getByRole('article', { name: /^Queued message /u })
    .filter({ hasText: 'Guide this work instead' });
  await queued.getByRole('button', { name: 'Steer instead' }).click();
  // Edit disappears at submitting, before native delivery is confirmed.
  // Stop only after Gateway acknowledgement or canonical user-message proof.
  await expect(
    transcript(page)
      .and(page.locator('[data-message-role="user"]'))
      .filter({ hasText: 'Guide this work instead' })
      .and(
        page.locator(
          '[data-message-state="submitted"], [data-message-state="canonical"]',
        ),
      ),
  ).toHaveCount(1);
  await expect(
    queued.getByRole('button', { name: 'Edit', exact: true }),
  ).toHaveCount(0);
  // Regression: ISSUE-001 — delivery can be confirmed after a short steer finishes.
  // Found by /qa on 2026-10-13; report: .context/local-acceptance-20261013/qa-report.md
  // Exercise abort against an explicitly active turn, not a possibly completed steer.
  await idle(page);
  await send(page, 'LONG_RESPONSE_FIXTURE explicit abort target');
  await expect(
    page.getByRole('button', { name: 'Stop this run' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stop this run' }).click();
  await idle(page);
  await send(page, 'LONG_RESPONSE_FIXTURE settings cancellation target');
  await send(page, 'Queued work to cancel');
  await page
    .getByRole('button', { name: 'Agent settings', exact: true })
    .click();
  const settings = page.getByRole('dialog', { name: 'Agent settings' });
  const responseStyle = settings.getByRole('combobox', {
    name: 'Response style',
    exact: true,
  });
  await expect(responseStyle).toBeEnabled();
  const save = settings.getByRole('button', { name: 'Save changes' });
  await expect(save).toBeDisabled();
  await responseStyle.click();
  await settings.getByRole('option', { name: 'Detailed', exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await settings
    .getByRole('button', { name: 'Cancel active and queued work, then apply' })
    .click();
  await idle(page);
  await expect(
    page.getByRole('article', { name: /^Queued message /u }),
  ).toHaveCount(0);
  await expect(
    transcript(page).filter({ hasText: 'Queued work to cancel' }),
  ).toHaveCount(0);
  // Work may be idle before the accepted settings operation has completed.
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/chats/${target}`);
      expect(response.status()).toBe(200);
      const chat = (await response.json()) as ChatSummary;
      return chat.settings.responseStyle;
    })
    .toBe('detailed');
  await page
    .getByRole('button', { name: 'Agent settings', exact: true })
    .click();
  await expect(responseStyle).toBeEnabled();
  await expect(responseStyle).toHaveAttribute('data-value', 'detailed');
  await expect(save).toBeDisabled();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(settings).not.toBeVisible();
  await goChat(page, other);
  await expect(transcript(page)).toHaveCount(0);
  await idle(page);
});

test('uploads reach the real model, tools stay readable and scoped artifacts download', async ({
  page,
}) => {
  const chatId = await createChat(page, 'File space');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('TEXT_FIXTURE_TOKEN'),
  });
  await expect(
    page.getByRole('button', { name: 'Remove notes.txt' }),
  ).toBeVisible();
  await mobileTarget(
    page,
    page.getByRole('button', { name: 'Remove notes.txt' }),
  );
  await send(page, 'Read this attached note');
  await idle(page);
  await expect(
    transcript(page).filter({ hasText: 'TEXT_FIXTURE_TOKEN' }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Remove notes.txt' }),
  ).not.toBeVisible();
  await send(page, 'TOOL_WRITE_FIXTURE create a useful file');
  await idle(page);
  const tool = page.getByRole('button', {
    name: 'write · completed · Tool details',
    exact: true,
  });
  await expect(tool).toBeVisible();
  await expect(tool).toHaveText('Write');
  await expect(tool).toHaveAttribute('aria-expanded', 'false');
  await mobileTarget(page, tool);
  await tool.click();
  const details = page.getByRole('dialog', {
    name: 'write · completed · Tool details',
    exact: true,
  });
  await expect(tool).toHaveAttribute('aria-expanded', 'true');
  await expect(
    details.getByRole('heading', { name: 'Parameters' }),
  ).toBeVisible();
  await expect(details).toContainText('artifact-fixture.txt');
  await page.keyboard.press('Escape');
  await expect(details).not.toBeVisible();
  await expect(tool).toBeFocused();
  seedWorkspaceImage(chatId);
  await send(page, 'TOOL_READ_IMAGE_FIXTURE inspect this workspace image');
  await idle(page);
  await mobileTarget(
    page,
    page.getByRole('button', { name: 'Conversation files', exact: true }),
  );
  await page
    .getByRole('button', { name: 'Conversation files', exact: true })
    .click();
  const file = page
    .getByRole('region', { name: 'Conversation files', exact: true })
    .getByRole('link', { name: /artifact-fixture.png/u })
    .first();
  await expect(file).toBeVisible();
  await mobileTarget(
    page,
    page.getByRole('button', { name: 'Refresh files', exact: true }),
  );
  await mobileTarget(page, file);
  const downloaded = page.waitForEvent('download');
  await file.click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBeTruthy();
  expect(download.suggestedFilename()).not.toContain('/');
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(await readFile(path)).toEqual(IMAGE_FIXTURE_BYTES);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'bad.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<script>alert("unsafe")</script>'),
  });
  await expect(page.getByRole('alert')).toContainText(
    'PNG, JPEG, WebP, UTF-8 text, Markdown, or PDF',
  );
  await expect(
    page.getByRole('button', { name: 'Remove bad.html' }),
  ).not.toBeVisible();
});

test('sign out revokes another open tab and accepted work survives browser closure', async ({
  page,
  context,
  browser,
}, testInfo) => {
  const id = await createChat(page, 'Continue without browser');
  await send(page, 'LONG_RESPONSE_FIXTURE finish after browser closes');
  await expect(
    page.getByText('Agent is working', { exact: false }),
  ).toBeVisible();
  const storageState = await context.storageState();
  const baseURL = new URL(page.url()).origin;
  await context.close();
  // No browser context or WebSocket remains while the agent completes accepted work.
  const api = await request.newContext({ baseURL, storageState });
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/chats/${id}`);
        return ((await response.json()) as { status: string }).status;
      },
      { timeout: 45_000 },
    )
    .toBe('idle');
  await api.dispose();
  const reopened = await browser.newContext({
    ...(testInfo.project.name === 'mobile'
      ? devices['Pixel 7']
      : devices['Desktop Chrome']),
    baseURL,
    storageState,
  });
  try {
    const second = await reopened.newPage();
    await second.goto(`/chat/${id}`);
    await expect(
      transcript(second).filter({
        hasText: 'Real Gateway integration response.',
      }),
    ).toHaveCount(1);
    const stale = await reopened.newPage();
    await stale.goto(`/chat/${id}`);
    await expect(
      stale.getByRole('textbox', { name: /^Message /u }),
    ).toBeVisible();
    await second.goto('/settings');
    await second.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(second).toHaveURL(/\/login$/u);
    await expect(stale).toHaveURL(/\/login$/u);
    expect((await stale.request.get('/api/chats')).status()).toBe(401);
    await login(second);
    await second.goto(`/chat/${id}`);
    await expect(
      transcript(second).filter({
        hasText: 'LONG_RESPONSE_FIXTURE finish after browser closes',
      }),
    ).toHaveCount(1);
  } finally {
    await reopened.close();
  }
});

test(restartTitle, async ({ page }) => {
  test.setTimeout(180_000);
  const project = process.env.ACCEPTANCE_PROJECT;
  test.skip(
    !project,
    'Run pnpm test:acceptance for isolated Compose restart checks.',
  );
  expect(project).toMatch(/^messenger-acceptance-[a-z0-9-]+$/u);
  await createChat(page, 'Restart space');
  await send(page, 'LONG_RESPONSE_FIXTURE active before backend restart');
  await send(page, 'Durable queued message after backend restart');
  execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.context/test.env',
      '-p',
      project as string,
      '-f',
      'compose.yaml',
      '-f',
      'compose.test.yaml',
      'restart',
      'backend',
    ],
    { stdio: 'pipe', timeout: 60_000 },
  );
  await idle(page);
  await expect(
    transcript(page).filter({
      hasText: 'Durable queued message after backend restart',
    }),
  ).toHaveCount(1);
  await expect(
    transcript(page).filter({
      hasText: 'LONG_RESPONSE_FIXTURE active before backend restart',
    }),
  ).toHaveCount(1);
  await expect(
    transcript(page).filter({ hasText: 'Real Gateway integration response.' }),
  ).toHaveCount(2);
  await send(page, 'RESTART_RESPONSE_FIXTURE active before Gateway restart');
  await send(page, 'Accepted queue while Gateway restarts');
  await expect(
    page.getByText('Agent is working', { exact: false }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: /^Message /u })
    .fill('Kept through Gateway restart');
  execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.context/test.env',
      '-p',
      project as string,
      '-f',
      'compose.yaml',
      '-f',
      'compose.test.yaml',
      'restart',
      'openclaw',
    ],
    { stdio: 'pipe', timeout: 60_000 },
  );
  await expect
    .poll(async () => (await page.request.get('/ready')).status(), {
      timeout: 90_000,
    })
    .toBe(200);
  await expect(page.getByRole('textbox', { name: /^Message /u })).toHaveValue(
    'Kept through Gateway restart',
  );
  // The pinned Gateway can resume the interrupted turn without retaining a
  // pending-input receipt. Missing proof must keep recovery visible, not replay
  // the canonical input or claim the queued follow-up finished automatically.
  await expect(
    transcript(page).filter({
      hasText: 'RESTART_RESPONSE_FIXTURE active before Gateway restart',
    }),
  ).toHaveCount(1);
  const unconfirmed = page.getByRole('article', {
    name: 'Queued message 1',
    exact: true,
  });
  await expect(unconfirmed).toContainText('Delivery unconfirmed');
  await expect(unconfirmed).toContainText(
    'RESTART_RESPONSE_FIXTURE active before Gateway restart',
  );
  const retainedQueue = page.getByRole('article', {
    name: 'Queued message 2',
    exact: true,
  });
  await expect(retainedQueue).toContainText(
    'Accepted queue while Gateway restarts',
  );
  await expect(
    transcript(page).filter({
      hasText: 'Accepted queue while Gateway restarts',
    }),
  ).toHaveCount(0);
  const continuation = transcript(page).filter({
    hasText: '[System] Your previous turn was interrupted by a gateway restart',
  });
  await expect(continuation).toHaveCount(1, { timeout: 60_000 });
  await expect(
    continuation.locator('xpath=following-sibling::article[1]'),
  ).toContainText('Real Gateway integration response.', { timeout: 60_000 });
  await expect(
    page.getByRole('button', { name: 'Stop this run', exact: true }),
  ).not.toBeVisible({ timeout: 45_000 });
  // The user has checked the canonical turn above. Explicitly discarding its
  // unresolved local delivery record must preserve that history and unblock
  // only the already accepted next item.
  await unconfirmed
    .getByRole('button', { name: 'Discard', exact: true })
    .click();
  const queuedCanonical = transcript(page).filter({
    hasText: 'Accepted queue while Gateway restarts',
  });
  // Idle can briefly appear between recovery resolution and asynchronous
  // dispatch. Wait for this item's canonical turn, not that intermediate state.
  await expect(queuedCanonical).toHaveCount(1, { timeout: 60_000 });
  await expect(
    queuedCanonical.locator('xpath=following-sibling::article[1]'),
  ).toContainText('Real Gateway integration response.', { timeout: 60_000 });
  await idle(page);
  await expect(unconfirmed).not.toBeVisible();
  const completedBeforeFollowup = await transcript(page)
    .filter({ hasText: 'Real Gateway integration response.' })
    .count();
  await send(page, 'Message after Gateway restart');
  await idle(page);
  await expect(
    transcript(page).filter({ hasText: 'Message after Gateway restart' }),
  ).toHaveCount(1);
  await expect(
    transcript(page).filter({ hasText: 'Real Gateway integration response.' }),
  ).toHaveCount(completedBeforeFollowup + 1);
  await expect(
    transcript(page).filter({
      hasText: 'RESTART_RESPONSE_FIXTURE active before Gateway restart',
    }),
  ).toHaveCount(1);
});

test(expiryTitle, async ({ page }) => {
  const project = process.env.ACCEPTANCE_PROJECT;
  test.skip(!project, 'Run the isolated Compose acceptance command.');
  expect(project).toMatch(/^messenger-acceptance-[a-z0-9-]+$/u);
  const id = await createChat(page, 'Expiry space');
  await send(page, 'LONG_RESPONSE_FIXTURE accepted before expiry');
  await expect(
    page.getByText('Agent is working', { exact: false }),
  ).toBeVisible();
  execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.context/test.env',
      '-p',
      project as string,
      '-f',
      'compose.yaml',
      '-f',
      'compose.test.yaml',
      'exec',
      '-T',
      '--workdir',
      '/app/apps/backend',
      'backend',
      'node',
      '--input-type=module',
      '-e',
      "import Database from 'better-sqlite3'; const db = new Database('/data/messenger.sqlite'); db.prepare('UPDATE sessions SET expires_at = 0 WHERE revoked = 0').run(); db.close();",
    ],
    { stdio: 'pipe', timeout: 15_000 },
  );
  await page
    .getByRole('textbox', { name: /^Message /u })
    .fill('Rejected after expiry');
  await page
    .getByRole('button', { name: 'Queue message', exact: false })
    .click();
  await expect(page).toHaveURL(/\/login$/u);
  expect((await page.request.get('/api/chats')).status()).toBe(401);
  await login(page);
  await page.goto(`/chat/${id}`);
  await idle(page);
  await expect(
    transcript(page).filter({
      hasText: 'LONG_RESPONSE_FIXTURE accepted before expiry',
    }),
  ).toHaveCount(1);
  await expect(
    transcript(page).filter({ hasText: 'Rejected after expiry' }),
  ).toHaveCount(0);
});
