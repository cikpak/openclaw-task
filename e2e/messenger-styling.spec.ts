import { mkdir } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { createChat, mobileTarget } from './helpers.js';

import { messengerSetup } from './messenger-setup.js';
messengerSetup();

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
