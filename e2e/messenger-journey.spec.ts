import { refreshAgentSettings } from './helpers.js';
import { mkdir } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  catalog,
  createChat,
  idle,
  mobileTarget,
  send,
  transcript,
} from './helpers.js';

import { messengerSetup } from './messenger-setup.js';
messengerSetup();

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
  await refreshAgentSettings(settings);
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
  await confirmDelete.click();
  // Wait for the actual manager result before inspecting the possible conflict.
  await expect
    .poll(
      async () =>
        new URL(page.url()).pathname === '/' ||
        (await settings.getByRole('alert').isVisible()),
    )
    .toBe(true);
  // A version conflict remains explicit; refresh and reconfirm once.
  if (await settings.getByRole('alert').isVisible()) {
    await settings
      .getByRole('button', {
        name: 'Refresh latest values and models, keep my edits',
      })
      .click();
    await confirmDelete.click();
  }
  await expect(page).toHaveURL(/\/$/u);
  await expect.poll(async () => (await catalog(page)).length).toBe(0);
});
