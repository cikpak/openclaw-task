import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { ModelsResponse } from '@messenger/contracts';
import { cleanChats, createChat, login } from './helpers.js';

test('select options escape clipped modal content, keep their border and remain interactive', async ({
  page,
}, info) => {
  expect(process.env.ACCEPTANCE_PROJECT).toMatch(
    /^messenger-acceptance-[a-z0-9-]+$/u,
  );
  await login(page);
  await cleanChats(page.request);
  const id = await createChat(page, 'Select layers');
  await page.route(`**/api/models?chatId=${id}`, async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as ModelsResponse;
    for (const model of data.models) {
      model.thinkingLevels = [
        'off',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'ultra',
      ].map((level) => ({ id: level, label: level }));
    }
    await route.fulfill({ response, json: data });
  });
  await page
    .getByRole('button', { name: 'Agent settings', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Agent settings' });
  const trigger = dialog.getByRole('combobox', {
    name: 'Thinking',
    exact: true,
  });
  await expect(trigger).toBeEnabled();
  // Reproduce the screenshot's clipping ancestor without relying on incidental
  // content height. The menu must escape it, not remove the form's overflow.
  await trigger.evaluate((element) => {
    const parent = element.parentElement!;
    Object.assign(parent.style, { height: '70px', overflow: 'hidden' });
    element.closest('dialog')!.style.overflow = 'hidden';
  });
  await trigger.click();
  const menu = page.getByRole('listbox', { name: 'Thinking options' });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('popover', 'manual');
  expect(
    await menu.evaluate((element) => element.matches(':popover-open')),
  ).toBe(true);
  await menu.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  const geometry = await menu.evaluate((element) => {
    const frame = element.firstElementChild!;
    const rect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    return {
      border: style.borderBottomWidth,
      bottomHit: frame.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.bottom - 2),
      ),
      x: rect.x,
      y: rect.y,
      right: rect.right,
      bottom: rect.bottom,
      scrollable: frame.scrollHeight > frame.clientHeight,
    };
  });
  expect(geometry.border).toBe('1px');
  expect(geometry.bottomHit).toBe(true);
  expect(geometry.scrollable).toBe(true);
  expect(geometry.x).toBeGreaterThanOrEqual(7);
  expect(geometry.y).toBeGreaterThanOrEqual(7);
  expect(geometry.right).toBeLessThanOrEqual(page.viewportSize()!.width - 7);
  expect(geometry.bottom).toBeLessThanOrEqual(page.viewportSize()!.height - 7);
  await mkdir('.context/screenshots', { recursive: true });
  await page.screenshot({
    path: `.context/screenshots/select-layer-${info.project.name}.png`,
  });
  await page.getByRole('option', { name: 'medium', exact: true }).click();
  await expect(trigger).toHaveAttribute('data-value', 'medium');
  await expect(trigger).toBeFocused();
  await expect(menu).not.toBeVisible();
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
