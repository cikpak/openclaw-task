import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import {
  syntheticAccount,
  box,
  sameBounds,
  menuInDialog,
} from './polish-helpers.js';
test('polished controls retain geometry, dialog focus, identity and connection feedback', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(150_000);
  const fault: { blocked: boolean; socket?: WebSocketRoute } = {
    blocked: false,
  };
  await context.routeWebSocket('**/ws/conversation?*', (socket) => {
    if (fault.blocked) {
      // Keep the connecting state observable, then simulate transport failure only.
      setTimeout(() => void socket.close({ code: 1012 }), 600);
    } else {
      const server = socket.connectToServer();
      const creations = new Set<string>();
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message)) as {
          type: string;
          commandId: string;
        };
        if (frame.type === 'chat.create') creations.add(frame.commandId);
        if (
          frame.type === 'chat.create' ||
          frame.type === 'conversation.recent.request'
        )
          fault.socket = socket;
        server.send(message);
      });
      server.onMessage(async (message) => {
        const frame = JSON.parse(String(message)) as { commandId?: string };
        if (frame.commandId && creations.has(frame.commandId))
          await new Promise((resolve) => setTimeout(resolve, 800));
        socket.send(message);
      });
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
  await expect(dot.locator('..')).toHaveText('Connected');
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
  await expect(page).toHaveTitle('Polish controls — OpenClaw');
  const settingsOpener = page.getByRole('button', {
    name: 'Agent settings',
    exact: true,
  });
  await settingsOpener.click();
  const settings = page.getByRole('dialog', { name: 'Agent settings' });
  await menuInDialog(page, settings, true);
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
  await menuInDialog(page, settings, true);
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
  await expect(dot.locator('..')).toHaveText('Connection unavailable');
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
