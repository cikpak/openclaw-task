import { expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { application } from './manager-client.js';
import { cleanChats, login, refreshAgentSettings } from './helpers.js';
export async function syntheticAccount(page: Page) {
  // Fail closed before any account cleanup: these journeys own only test volumes.
  expect(process.env.ACCEPTANCE_PROJECT).toMatch(
    /^messenger-acceptance-[a-z0-9-]+$/u,
  );
  await login(page);
  const response = await application(page).get('/api/models?refresh=true');
  expect(response.status()).toBe(200);
  const { models } = (await response.json()) as {
    models: Array<{ id: string }>;
  };
  expect(models.some((model) => model.id === 'mock/test-model')).toBe(true);
  await cleanChats(page);
  await page.reload();
}

export async function box(target: Locator) {
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

export function sameBounds(
  before: { x: number; y: number; width: number; height: number },
  after: { x: number; y: number; width: number; height: number },
) {
  for (const key of ['x', 'y', 'width', 'height'] as const)
    expect(
      Math.abs(before[key] - after[key]),
      `${key} stays stable`,
    ).toBeLessThanOrEqual(1);
}

export async function menuInDialog(
  page: Page,
  dialog: Locator,
  refreshModels = false,
) {
  if (refreshModels) await refreshAgentSettings(dialog);
  const model = dialog.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toBeEnabled();
  await model.focus();
  await expect(model).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const menu = dialog.getByRole('listbox', { name: 'Model options' });
  await expect(menu).toBeVisible();
  const selected = menu.getByRole('option', { selected: true });
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute('data-value', 'mock/test-model');
  await expect(selected).toBeEnabled();
  await selected.hover();
  await expect(selected).toHaveCSS('background-color', 'rgb(240, 240, 240)');
  const bounds = await box(menu);
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(model).toBeFocused();
  await model.press('ArrowDown');
  await expect(selected).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(model).toHaveAttribute('data-value', 'mock/test-model');
  await expect(menu).not.toBeVisible();
}
