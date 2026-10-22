import { refreshAgentSettings } from './helpers.js';
import { application } from './manager-client.js';

import { expect, test } from '@playwright/test';

import type { ChatSummary } from '@messenger/contracts';
import { createChat, goChat, idle, send, transcript } from './helpers.js';

import { messengerSetup } from './messenger-setup.js';
messengerSetup();

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
  await refreshAgentSettings(settings);
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
      const response = await application(page).get(`/api/chats/${target}`);
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
