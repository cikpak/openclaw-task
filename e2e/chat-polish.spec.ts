import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Locator, Page, WebSocketRoute } from '@playwright/test';
import { cleanChats, createChat, idle, login, send } from './helpers.js';

async function syntheticAccount(page: Page) {
  // Fail closed before any account cleanup: these journeys own only test volumes.
  expect(process.env.ACCEPTANCE_PROJECT).toMatch(
    /^messenger-acceptance-[a-z0-9-]+$/u,
  );
  await login(page);
  const response = await page.request.get('/api/models');
  expect(response.status()).toBe(200);
  const { models } = (await response.json()) as {
    models: Array<{ id: string }>;
  };
  expect(models.some((model) => model.id === 'mock/test-model')).toBe(true);
  await cleanChats(page.request);
  await page.reload();
}

async function box(target: Locator) {
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

function sameBounds(
  before: { x: number; y: number; width: number; height: number },
  after: { x: number; y: number; width: number; height: number },
) {
  for (const key of ['x', 'y', 'width', 'height'] as const)
    expect(
      Math.abs(before[key] - after[key]),
      `${key} stays stable`,
    ).toBeLessThanOrEqual(1);
}

async function menuInDialog(page: Page, dialog: Locator) {
  const model = dialog.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toBeEnabled();
  await model.focus();
  await expect(model).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const menu = dialog.getByRole('listbox', { name: 'Model options' });
  await expect(menu).toBeVisible();
  const selected = menu.getByRole('option', { selected: true });
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute('data-value', 'mock/test-model');
  await selected.hover();
  await expect(selected).toHaveCSS('background-color', 'rgb(240, 240, 240)');
  const bounds = await box(menu);
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(model).toBeFocused();
  await model.press('ArrowDown');
  await expect(selected).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(model).toHaveAttribute('data-value', 'mock/test-model');
  await expect(menu).not.toBeVisible();
}

test('polished controls retain geometry, dialog focus, identity and connection feedback', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(150_000);
  const fault: { blocked: boolean; socket?: WebSocketRoute } = {
    blocked: false,
  };
  await context.routeWebSocket('**/ws/conversation', (socket) => {
    if (fault.blocked) {
      // Keep the connecting state observable, then simulate transport failure only.
      setTimeout(() => void socket.close({ code: 1012 }), 600);
    } else {
      fault.socket = socket;
      socket.connectToServer();
    }
  });
  await syntheticAccount(page);
  await expect(page).toHaveTitle('Conversations — OpenClaw');
  const favicon = page.locator('link[rel="icon"]');
  await expect(favicon).toHaveAttribute('href', /favicon/u);
  const iconReply = await page.request.get(
    (await favicon.getAttribute('href'))!,
  );
  expect(iconReply.ok()).toBe(true);
  expect(iconReply.headers()['content-type']).toContain('image/svg+xml');
  const dot = page.locator('[data-connection-state]');
  await expect(dot).toHaveAttribute('data-connection-state', 'ready');
  await expect(dot).toHaveCSS('width', '10px');
  await expect(dot).toHaveCSS('height', '10px');
  await expect(dot).toHaveCSS('background-color', 'rgb(21, 128, 61)');
  await expect(dot.locator('..')).toHaveText('Gateway connected');
  const green = await dot.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  const opener = page.getByRole('button', { name: 'New conversation' });
  await opener.click();
  const creation = page.getByRole('dialog', { name: 'Start a conversation' });
  expect(
    await creation.evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
  ).not.toBe('none');
  await menuInDialog(page, creation);
  await creation.getByRole('button', { name: 'Close dialog' }).click();
  await expect(creation).toHaveAttribute('data-closing', 'true');
  await expect(creation).not.toBeVisible();
  await expect(opener).toBeFocused();

  await opener.click();
  await creation.getByRole('button', { name: 'Continue', exact: true }).click();
  await creation.getByLabel('Name optional').fill('Polish controls');
  await page.route('**/api/chats', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ response });
  });
  const create = creation.getByRole('button', {
    name: 'Create chat',
    exact: true,
  });
  const createBefore = await box(create);
  await create.click();
  await expect(create).toHaveAttribute('aria-busy', 'true');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAccessibleName('Create chat');
  sameBounds(createBefore, await box(create));
  await expect(create.locator('svg')).toHaveCSS('width', '16px');
  await expect(create.locator('svg')).toHaveCSS('height', '16px');
  await expect(create.locator('svg')).toHaveAttribute('viewBox', '0 0 24 24');
  await expect(
    page.getByRole('heading', { name: 'Polish controls', exact: true }),
  ).toBeVisible();
  await page.unroute('**/api/chats');
  await expect(page).toHaveTitle('Polish controls — OpenClaw');
  const settingsOpener = page.getByRole('button', {
    name: 'Agent settings',
    exact: true,
  });
  await settingsOpener.click();
  const settings = page.getByRole('dialog', { name: 'Agent settings' });
  await menuInDialog(page, settings);
  const saveSettings = settings.getByRole('button', { name: 'Save changes' });
  await expect(saveSettings).toBeDisabled();
  await settings.getByLabel('Conversation name').fill('Renamed polish');
  await expect(saveSettings).toBeEnabled();
  await saveSettings.click();
  await expect(settings).not.toBeVisible();
  await expect(page).toHaveTitle('Renamed polish — OpenClaw');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(
    page.getByText('Conversation name saved.', { exact: true }),
  ).toBeVisible();
  await settingsOpener.click();
  await expect(settings).toBeVisible();
  await expect(settings).toHaveCSS('animation-name', 'none');
  await menuInDialog(page, settings);
  await expect(saveSettings).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(settings).not.toBeVisible();
  await expect(settingsOpener).toBeFocused();
  const iconSizes = await page.locator('svg').evaluateAll((elements) =>
    elements.map((element) => ({
      width: getComputedStyle(element).width,
      height: getComputedStyle(element).height,
      fill: element.getAttribute('fill'),
      stroke: element.getAttribute('stroke-width'),
      viewBox: element.getAttribute('viewBox'),
    })),
  );
  expect(iconSizes.length).toBeGreaterThan(2);
  for (const icon of iconSizes)
    expect(icon).toEqual({
      width: '16px',
      height: '16px',
      fill: 'none',
      stroke: '1.5',
      viewBox: '0 0 24 24',
    });
  for (const marker of await page
    .locator('summary')
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).listStyleType),
    ))
    expect(marker).toBe('none');

  await page.goto('/settings');
  await expect(page).toHaveTitle('Settings — OpenClaw');
  const behavior = page.getByRole('combobox', {
    name: 'Default send behavior',
  });
  await expect(behavior).toBeEnabled();
  const savePreferences = page.getByRole('button', {
    name: 'Save preferences',
    exact: true,
  });
  await expect(savePreferences).toBeDisabled();
  await behavior.press('ArrowDown');
  const behaviorMenu = page.getByRole('listbox', {
    name: 'Default send behavior options',
  });
  await expect(
    behaviorMenu.getByRole('option', { selected: true }),
  ).toBeFocused();
  await page.keyboard.press('End');
  await expect(
    behaviorMenu.getByRole('option', {
      name: 'Steer · guide the current run',
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(behavior).toHaveAttribute('data-value', 'steer');
  await expect(savePreferences).toBeEnabled();
  await expect(behaviorMenu).not.toBeVisible();
  await behavior.press('ArrowDown');
  await expect(
    behaviorMenu.getByRole('option', { selected: true }),
  ).toBeFocused();
  await page.keyboard.press('Home');
  await expect(
    behaviorMenu.getByRole('option', {
      name: 'Queue · wait for the current work to finish',
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(behavior).toHaveAttribute('data-value', 'queue');
  await expect(savePreferences).toBeDisabled();
  await page.goto('/');
  fault.blocked = true;
  await fault.socket?.close({ code: 1012 });
  await expect(dot).toHaveAttribute('data-connection-state', 'unavailable');
  await expect(dot).toHaveCSS('background-color', 'rgb(220, 38, 38)');
  await expect(dot.locator('..')).toHaveText('Gateway unavailable');
  const red = await dot.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(red).not.toBe(green);
  await expect(dot).toHaveAttribute('data-connection-state', 'connecting');
  await expect(dot).toHaveCSS('background-color', 'rgb(202, 138, 4)');
  await expect(dot.locator('..')).toHaveText('Connecting…');
  const yellow = await dot.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(yellow).not.toBe(green);
  expect(yellow).not.toBe(red);
  fault.blocked = false;
  await expect(dot).toHaveAttribute('data-connection-state', 'ready');
  await mkdir('.context/screenshots', { recursive: true });
  await writeFile(
    `.context/chat-polish-controls-${testInfo.project.name}.json`,
    JSON.stringify({ createBefore, iconSizes, green, red, yellow }, null, 2),
  );
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveTitle('Sign in — OpenClaw');
});

type StreamEvidence = {
  frames: Array<{ size: number; visibleSize: number; at: number }>;
  paints: Array<{
    size: number;
    at: number;
    delay: number;
    matchesFrame: boolean;
    inView: boolean;
    sameNode: boolean;
  }>;
  terminalAt: number | null;
};

test('real incremental text stays chronological, readable and reader-controlled', async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  if (testInfo.project.name === 'desktop')
    await page.setViewportSize({ width: 960, height: 900 });
  await page.addInitScript(() => {
    const state: StreamEvidence = { frames: [], paints: [], terminalAt: null };
    Object.assign(window, { polishStream: state });
    let projectedRunId = '';
    let projectedText = '';
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event: MessageEvent<string>) => {
          const frame = JSON.parse(event.data) as {
            type: string;
            text?: string;
            runId?: string;
            replace?: boolean;
            snapshot?: { activeRun?: unknown; settledRun?: unknown };
          };
          if (
            frame.type === 'conversation.run.text' &&
            frame.text &&
            frame.runId
          ) {
            if (frame.runId !== projectedRunId || frame.replace)
              projectedText = '';
            projectedRunId = frame.runId;
            projectedText = (projectedText + frame.text).slice(0, 256 * 1024);
            state.frames.push({
              size: projectedText.length,
              visibleSize: projectedText.trimEnd().length,
              at: performance.now(),
            });
          }
          if (
            state.frames.length &&
            frame.type === 'conversation.snapshot' &&
            !frame.snapshot?.activeRun
          )
            state.terminalAt ??= performance.now();
        });
      }
    };
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        const content = document.querySelector(
          '[data-message-state="active"] > [data-message-content]',
        );
        const text = content?.textContent ?? '';
        if (!text || text === 'Thinking…' || !state.frames.length) return;
        const size = Number(content?.getAttribute('data-message-source-size'));
        if (!size) return;
        if (state.paints.at(-1)?.size === size) return;
        const frame = state.frames.findLast(
          (received) =>
            received.size === size && received.visibleSize === text.length,
        );
        const previousNode = (
          window as unknown as { polishReplyNode?: Element }
        ).polishReplyNode;
        if (!previousNode) Object.assign(window, { polishReplyNode: content });
        requestAnimationFrame(() =>
          state.paints.push({
            size,
            at: performance.now(),
            delay: frame
              ? performance.now() - frame.at
              : Number.POSITIVE_INFINITY,
            matchesFrame: !!frame,
            sameNode: !previousNode || previousNode === content,
            inView:
              !!content &&
              content.getBoundingClientRect().top >= 0 &&
              content.getBoundingClientRect().bottom <= innerHeight,
          }),
        );
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
  });
  await syntheticAccount(page);
  await createChat(page, 'Streaming polish');
  const longText =
    `First chronological question ${'unbroken-text-'.repeat(100)}\n${'Readable line in a long message.\n'.repeat(40)}`.trimEnd();
  await send(page, longText);
  await idle(page);
  const composer = page.getByRole('textbox', {
    name: 'Message Streaming polish',
    exact: true,
  });
  const form = composer.locator('..');
  const action = form.getByRole('button', {
    name: 'Send message',
    exact: true,
  });
  const idleBounds = await box(action);
  await page.evaluate(() => {
    const state = (window as unknown as { polishStream: StreamEvidence })
      .polishStream;
    state.frames = [];
    state.paints = [];
    state.terminalAt = null;
    delete (window as unknown as { polishReplyNode?: Element }).polishReplyNode;
  });
  const secondPrompt =
    'DELAY_RESPONSE_FIXTURE Second chronological question TEXT_FIXTURE_TOKEN MARKDOWN_FIXTURE_TOKEN PDF_FIXTURE_TOKEN';
  const finalReply =
    'Real Gateway integration response. TEXT_FIXTURE_TOKEN MARKDOWN_FIXTURE_TOKEN PDF_FIXTURE_TOKEN';
  await send(page, secondPrompt);
  const thinking = page.getByRole('status', { name: 'Agent is thinking' });
  await expect(thinking).toBeVisible();
  const liveBubble = thinking.locator('..');
  expect(
    await liveBubble.evaluate(
      (element) => element.parentElement?.lastElementChild === element,
    ),
    'Thinking is the final transcript element, after submitted input',
  ).toBe(true);
  await expect(liveBubble).toHaveCSS('border-top-width', '0px');
  const shimmer = await thinking
    .locator('span')
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(shimmer).not.toBe('none');
  const queue = form.getByRole('button', {
    name: 'Queue message',
    exact: true,
  });
  sameBounds(idleBounds, await box(queue));
  const mode = form.getByRole('combobox', { name: 'Send behavior' });
  await mode.click();
  await page
    .getByRole('option', { name: 'Steer current run', exact: true })
    .click();
  const steer = form.getByRole('button', { name: 'Steer agent', exact: true });
  sameBounds(idleBounds, await box(steer));
  const modeBounds = await box(mode);
  const steerBounds = await box(steer);
  expect(
    Math.abs(
      modeBounds.y +
        modeBounds.height / 2 -
        steerBounds.y -
        steerBounds.height / 2,
    ),
  ).toBeLessThanOrEqual(1);
  const history = page.locator('[data-message-id]').first().locator('../..');
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { polishStream: StreamEvidence }).polishStream
              .paints.length,
        ),
      { intervals: [20] },
    )
    .toBeGreaterThanOrEqual(1);
  expect(
    await page
      .locator('[data-message-state="active"] > [data-message-content]')
      .evaluate((element) => getComputedStyle(element).animationName),
  ).not.toBe('none');
  await history.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(thinking).not.toBeVisible();
  await idle(page);
  expect(
    await history.evaluate((element) => element.scrollTop),
    'Streaming does not pull a reader off older content',
  ).toBeLessThanOrEqual(1);
  await page
    .getByRole('button', { name: 'Jump to latest', exact: true })
    .click();
  await expect
    .poll(() =>
      history.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect
    .poll(() => page.locator('[data-message-state="canonical"]').count())
    .toBe(4);
  const messages = page.locator('[data-message-state="canonical"]');
  for (const message of await messages.all()) {
    await expect(message).toHaveCSS('border-top-width', '0px');
    await expect(message).toHaveCSS('border-left-width', '0px');
  }
  const ordered = await messages.evaluateAll((elements) =>
    elements.map((element) => ({
      role: element.getAttribute('data-message-role'),
      text: element.querySelector('[data-message-content]')?.textContent,
    })),
  );
  expect(ordered.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
  expect(ordered[0]?.text).toBe(longText);
  expect(ordered[2]?.text).toBe(secondPrompt);
  expect(ordered[1]?.text).toBe('Real Gateway integration response.');
  expect(ordered[3]?.text).toBe(finalReply);
  const bubbles = await messages.evaluateAll((elements) =>
    elements.map((element) => {
      const bubble = element.getBoundingClientRect();
      const column = element.parentElement!.getBoundingClientRect();
      return {
        role: element.getAttribute('data-message-role'),
        width: bubble.width,
        column: column.width,
        left: bubble.left - column.left,
        right: column.right - bubble.right,
      };
    }),
  );
  for (const bubble of bubbles) {
    expect(bubble.width).toBeLessThanOrEqual(bubble.column * 0.85 + 1);
    expect(
      Math.abs(bubble.role === 'user' ? bubble.right : bubble.left),
    ).toBeLessThanOrEqual(1);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const evidence = await page.evaluate(
    () => (window as unknown as { polishStream: StreamEvidence }).polishStream,
  );
  expect(evidence.frames.length).toBeGreaterThanOrEqual(2);
  const partials = evidence.paints.filter(
    (paint) => paint.size < finalReply.length,
  );
  expect(
    partials[0]?.inView,
    'First partial response is visibly painted before scrolling away',
  ).toBe(true);
  expect(
    new Set(partials.map((paint) => paint.size)).size,
  ).toBeGreaterThanOrEqual(2);
  expect(
    partials[0]?.delay,
    'Frame-to-foreground partial paint',
  ).toBeLessThanOrEqual(150);
  expect(
    partials.every((paint) => paint.matchesFrame),
    'No fabricated character-at-a-time updates',
  ).toBe(true);
  expect(evidence.terminalAt).not.toBeNull();
  expect(
    evidence.paints.every((paint) => paint.sameNode),
    'Streaming deltas preserve the animated reply node',
  ).toBe(true);
  const finalContent = page
    .locator(
      '[data-message-state="canonical"][data-message-role="assistant"] > [data-message-content]',
    )
    .last();
  expect(
    await finalContent.evaluate(
      (element) =>
        element ===
        (window as unknown as { polishReplyNode?: Element }).polishReplyNode,
    ),
    'Canonical handoff preserves the animated reply node',
  ).toBe(true);
  expect(partials.every((paint) => paint.at < evidence.terminalAt!)).toBe(true);
  await mkdir('.context/screenshots', { recursive: true });
  await page.screenshot({
    path: `.context/screenshots/chat-polish-${testInfo.project.name}.png`,
    fullPage: true,
    scale: 'css',
  });
  await writeFile(
    `.context/chat-polish-stream-${testInfo.project.name}.json`,
    JSON.stringify({ evidence, idleBounds, steerBounds, bubbles }, null, 2),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(finalContent).toHaveCSS('animation-name', 'none');
});
