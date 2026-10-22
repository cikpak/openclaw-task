import { acceptanceControl } from './runtime-control.js';
import { expect, test } from '@playwright/test';

import { createChat, idle, login, send, transcript } from './helpers.js';

import { messengerSetup, expiryTitle } from './messenger-setup.js';
messengerSetup();

test(expiryTitle, async ({ page }) => {
  const project = process.env.ACCEPTANCE_PROJECT;
  test.skip(!project, 'Run the isolated Cloudflare acceptance command.');
  expect(project).toMatch(/^messenger-acceptance-[a-z0-9-]+$/u);
  const id = await createChat(page, 'Expiry space');
  await send(page, 'LONG_RESPONSE_FIXTURE accepted before expiry');
  await expect(
    page.getByText('Agent is working', { exact: false }),
  ).toBeVisible();
  await acceptanceControl('expire-sessions');
  await page
    .getByRole('textbox', { name: /^Message /u })
    .fill('Rejected after expiry');
  await page
    .getByRole('button', { name: 'Queue message', exact: false })
    .click();
  await expect(page).toHaveURL(/\/login$/u);
  expect(
    (
      await page.request.post('/api/connection-tickets', {
        headers: { origin: new URL(page.url()).origin },
      })
    ).status(),
  ).toBe(401);
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
