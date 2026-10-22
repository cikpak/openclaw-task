import { readFile } from 'node:fs/promises';
const IMAGE_FIXTURE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

import { expect, test } from '@playwright/test';

import { createChat, idle, mobileTarget, send, transcript } from './helpers.js';

import { messengerSetup } from './messenger-setup.js';
messengerSetup();

test('uploads reach the real model, private tools stay hidden and image inputs reach the model', async ({
  page,
}) => {
  await createChat(page, 'File space');
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
  await send(page, 'TOOL_WRITE_DOC_FIXTURE create a useful file');
  await idle(page);
  await expect(page.locator('[data-tool-id]')).toHaveCount(1);
  await expect(page.locator('main')).not.toContainText('/recovery/');
  await expect(page.locator('main')).not.toContainText('auth-profiles.json');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'image-fixture.png',
    mimeType: 'image/png',
    buffer: IMAGE_FIXTURE_BYTES,
  });
  await expect(
    page.getByRole('button', { name: 'Remove image-fixture.png' }),
  ).toBeVisible();
  await send(page, 'Inspect this attached image');
  await idle(page);
  await expect(
    transcript(page).filter({ hasText: 'IMAGE_FIXTURE_TOKEN' }),
  ).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Conversation files', exact: true })
    .click();
  const panel = page.getByRole('region', {
    name: 'Conversation files',
    exact: true,
  });
  await expect(
    panel.getByText('image-fixture.png', { exact: false }),
  ).toBeVisible();
  const image = panel.getByRole('button', {
    name: 'image-fixture.png',
    exact: true,
  });
  await mobileTarget(page, image);
  const pendingDownload = page.waitForEvent('download');
  await image.click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe('image-fixture.png');
  expect(await download.failure()).toBeNull();
  expect(await readFile(await download.path())).toEqual(IMAGE_FIXTURE_BYTES);
  await panel.getByRole('button', { name: 'Close conversation files' }).click();
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
