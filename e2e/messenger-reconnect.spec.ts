import { expect, test } from '@playwright/test';

import { createChat, goChat, idle, send, transcript } from './helpers.js';

import {
  messengerSetup,
  reconnectTitle,
  networkFault,
} from './messenger-setup.js';
messengerSetup();

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
