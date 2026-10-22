import { refreshAgentSettings } from './helpers.js';
import { expect, test } from '@playwright/test';

import {
  createChat,
  goChat,
  idle,
  mobileTarget,
  send,
  transcript,
} from './helpers.js';

import { messengerSetup } from './messenger-setup.js';
messengerSetup();

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
  await refreshAgentSettings(settings);
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
