import { devices, expect, test } from '@playwright/test';

import { createChat, login, send, transcript } from './helpers.js';

import { messengerSetup } from './messenger-setup.js';
messengerSetup();

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
  // Leave accepted work without any browser or observer socket, then reconnect.
  await new Promise((resolve) => setTimeout(resolve, 35_000));
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
    expect(
      (
        await stale.request.post('/api/connection-tickets', {
          headers: { origin: new URL(stale.url()).origin },
        })
      ).status(),
    ).toBe(401);
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
