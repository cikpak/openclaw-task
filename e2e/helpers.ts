import { application } from './manager-client.js';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ChatSettings, ChatSummary } from '@messenger/contracts';

const origin =
  process.env.ACCEPTANCE_ORIGIN ??
  `http://localhost:${process.env.ACCEPTANCE_PORT ?? 18080}`;

export async function login(page: Page) {
  await page.goto('/login');
  await page
    .getByLabel('Username', { exact: true })
    .fill(process.env.APP_USERNAME ?? 'admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill(
      await readFile(
        process.env.ACCEPTANCE_PASSWORD_FILE ?? '.context/test-password.txt',
        'utf8',
      ),
    );
  async function submit() {
    const [response] = await Promise.all([
      page.waitForResponse(
        (reply) =>
          new URL(reply.url()).pathname === '/api/session' &&
          reply.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Sign in', exact: false }).click(),
    ]);
    return response;
  }
  let response = await submit();
  if (response.status() === 429) {
    // Whole-suite probes share a loopback client and the real five/minute limit.
    // Honour the server's cooldown; never disable or raise production throttling.
    const retryAfter = response.headers()['retry-after'] ?? '60';
    expect(retryAfter).toMatch(/^\d+$/u);
    const cooldown = (Number(retryAfter) + 1) * 1000;
    expect(cooldown).toBeLessThanOrEqual(61_000);
    test.setTimeout(test.info().timeout + cooldown);
    console.info(`Honouring login rate limit: wait ${cooldown / 1000}s.`);
    await new Promise((resolve) => setTimeout(resolve, cooldown));
    response = await submit();
  }
  expect(response.status(), 'Test credentials must authenticate').toBe(200);
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.locator('[data-connection-state="ready"]')).toBeVisible();
}

export async function mobileTarget(page: Page, target: Locator) {
  if ((page.viewportSize()?.width ?? 1280) >= 700) return;
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  expect(
    box,
    'An interactive mobile control must have a rendered target',
  ).not.toBeNull();
  // Chromium's float32 box coordinates can undershoot exact CSS sizes by micro-pixels.
  const measurementEpsilon = 0.0001;
  expect(
    (box?.width ?? 0) + measurementEpsilon,
    'Mobile target width',
  ).toBeGreaterThanOrEqual(44);
  expect(
    (box?.height ?? 0) + measurementEpsilon,
    'Mobile target height',
  ).toBeGreaterThanOrEqual(44);
}

export async function readableField(field: Locator) {
  expect(
    await field.evaluate((element) =>
      parseFloat(getComputedStyle(element).fontSize),
    ),
  ).toBeGreaterThanOrEqual(16);
}

export async function catalog(page: Page) {
  const response = await application(page).get('/api/chats');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { chats: ChatSummary[] }).chats;
}

export async function cleanChats(page: Page) {
  for (const chat of await catalog(page)) {
    const response = await application(page).delete(`/api/chats/${chat.id}`, {
      headers: { origin, 'If-Match': `"${chat.version}"` },
    });
    if (response.status() === 404) {
      // The previous Gateway/media probe may already be completing deletion.
      // Accept disappearance only after the catalog confirms this exact ID is gone.
      expect(
        (await catalog(page)).some((current) => current.id === chat.id),
      ).toBe(false);
    } else {
      expect([202, 204]).toContain(response.status());
    }
  }
  await expect
    .poll(async () => (await catalog(page)).length, { timeout: 45_000 })
    .toBe(0);
  const preferences = await application(page).get('/api/preferences');
  const saved = await application(page).patch('/api/preferences', {
    headers: { origin, 'If-Match': preferences.headers().etag ?? '' },
    data: {
      busySendBehavior: 'queue',
      defaults: {
        model: 'mock/test-model',
        thinkingLevel: 'off',
        fastMode: false,
      },
    },
  });
  expect(saved.status()).toBe(200);
  // Legacy three-field input must normalize to all six current settings fields.
  const normalized = (await saved.json()) as { defaults: ChatSettings };
  expect(normalized.defaults).toEqual({
    model: 'mock/test-model',
    thinkingLevel: 'off',
    fastMode: false,
    customInstructions: '',
    responseStyle: 'default',
    personality: 'neutral',
  });
}

export async function createChat(page: Page, name: string, prompt = '') {
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation' }).click();
  const modal = page.getByRole('dialog', { name: 'Start a conversation' });
  await expect(
    modal.getByRole('combobox', { name: 'Model', exact: true }),
  ).toHaveAttribute('data-value', 'mock/test-model');
  await modal.getByRole('button', { name: 'Continue', exact: true }).click();
  await readableField(modal.getByLabel('Name optional'));
  await modal.getByLabel('Name optional').fill(name);
  await modal.getByLabel('First message optional').fill(prompt);
  await modal.getByRole('button', { name: 'Create chat', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: `Message ${name}`, exact: true }),
  ).toBeVisible();
  await readableField(
    page.getByRole('textbox', { name: `Message ${name}`, exact: true }),
  );
  await mobileTarget(
    page,
    page.getByRole('button', { name: 'Agent settings', exact: true }),
  );
  const id = new URL(page.url()).pathname.split('/').at(-1);
  expect(id).toBeTruthy();
  return id as string;
}

export async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: /^Message /u }).fill(text);
  await page
    .getByRole('button', { name: /^(Send message|Queue message|Steer agent)/u })
    .click();
  await expect(page.getByRole('textbox', { name: /^Message /u })).toHaveValue(
    '',
  );
}

export async function idle(page: Page) {
  await expect
    .poll(
      async () => ({
        ready: await page
          .locator('main header')
          .getByText(/^(Ready when you are|Reply ready)\s*·/u)
          .isVisible(),
        active: await page
          .getByRole('button', { name: 'Stop this run', exact: true })
          .count(),
        pending: await page
          .getByRole('article', { name: /^Queued message /u })
          .count(),
      }),
      { timeout: 60_000 },
    )
    .toEqual({ ready: true, active: 0, pending: 0 });
}

export function transcript(page: Page) {
  return page.locator('article').filter({ has: page.locator('time') });
}

export async function goChat(page: Page, id: string) {
  // Use the ordinary mobile Back/list flow; desktop uses the same link.
  const back = page.getByRole('link', { name: 'Back to conversations' });
  if (await back.isVisible()) {
    await mobileTarget(page, back);
    await back.click();
  } else await page.getByRole('link', { name: 'openclaw' }).click();
  await page
    .locator(`nav[aria-label="Conversations"] a[href="/chat/${id}"]`)
    .click();
  await expect(page.getByRole('textbox', { name: /^Message /u })).toBeVisible();
}

/** Live capability verification is a deliberate action; opening cached settings stays asleep. */
export async function refreshAgentSettings(dialog: Locator) {
  const refresh = dialog.getByRole('button', {
    name: 'Refresh latest values and models, keep my edits',
  });
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect(
    dialog.getByText('Latest saved values:', { exact: false }),
  ).toBeVisible();
  await expect(refresh).toBeEnabled();
}
