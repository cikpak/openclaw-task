import { application } from './manager-client.js';
import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Attachment } from '@messenger/contracts';
import {
  cleanChats,
  createChat,
  goChat,
  idle,
  login,
  send,
  transcript,
} from './helpers.js';

test('sent uploads remain in their conversation files after completion and reload', async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  expect(process.env.ACCEPTANCE_PROJECT).toMatch(
    /^messenger-acceptance-[a-z0-9-]+$/u,
  );
  await login(page);
  const models = await application(page).get('/api/models?refresh=true');
  expect(models.ok()).toBe(true);
  expect(
    ((await models.json()) as { models: Array<{ id: string }> }).models.some(
      (model) => model.id === 'mock/test-model',
    ),
  ).toBe(true);
  await cleanChats(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation' }).click();
  const creation = page.getByRole('dialog', { name: 'Start a conversation' });
  await expect(
    creation.getByRole('combobox', { name: 'Model', exact: true }),
  ).toHaveAttribute('data-value', 'mock/test-model');
  await creation.getByRole('button', { name: 'Continue', exact: true }).click();
  await creation.getByLabel('Name optional').fill('Shared files');
  await creation
    .getByLabel('First message optional')
    .fill('DELAY_RESPONSE_FIXTURE Read the initial attachment');
  await creation.locator('input[type="file"]').setInputFiles({
    name: 'initial-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('TEXT_FIXTURE_TOKEN'),
  });
  await expect(
    creation.getByRole('button', { name: 'Remove initial-note.txt' }),
  ).toBeVisible();
  await creation
    .getByRole('button', { name: 'Create chat', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Shared files', exact: true }),
  ).toBeVisible();
  const chatId = new URL(page.url()).pathname.split('/').at(-1)!;
  const submitted = page
    .locator('[data-message-state="submitted"]')
    .filter({ hasText: 'Read the initial attachment' });
  await expect(submitted).toBeVisible();
  await expect(submitted.locator('header')).toContainText('You');
  await expect(submitted.locator('time')).toBeVisible();
  await expect(
    page.getByText('Submitted to agent', { exact: true }),
  ).not.toBeVisible();
  await idle(page);
  await expect(
    transcript(page).filter({ hasText: 'TEXT_FIXTURE_TOKEN' }),
  ).toHaveCount(1);
  const trigger = page.getByRole('button', {
    name: 'Conversation files',
    exact: true,
  });
  const panel = page.getByRole('region', {
    name: 'Conversation files',
    exact: true,
  });
  const shared = panel.getByRole('region', {
    name: 'Shared with agent',
    exact: true,
  });
  const agent = panel.getByRole('region', { name: 'From agent', exact: true });
  await trigger.click();
  await expect(
    shared.getByText('initial-note.txt', { exact: false }),
  ).toBeVisible();
  await expect(shared.getByRole('link')).toHaveCount(0);
  await expect(agent.getByRole('link')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close conversation files' }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'follow-up.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Follow-up\nMARKDOWN_FIXTURE_TOKEN'),
  });
  await expect(
    page.getByRole('button', { name: 'Remove follow-up.md' }),
  ).toBeVisible();
  await send(page, 'Read this follow-up attachment');
  await idle(page);
  await expect(
    transcript(page).filter({ hasText: 'MARKDOWN_FIXTURE_TOKEN' }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Remove follow-up.md' }),
  ).not.toBeVisible();
  async function retainedMetadata() {
    const response = await application(page).get(
      `/api/chats/${chatId}/shared-files`,
    );
    expect(response.status()).toBe(200);
    const { files } = (await response.json()) as { files: Attachment[] };
    expect(files).toHaveLength(2);
    expect(files.map((file) => file.name).sort()).toEqual([
      'follow-up.md',
      'initial-note.txt',
    ]);
    for (const file of files) {
      expect(file.uploadId).toMatch(/^[a-zA-Z0-9_-]+$/u);
      expect(file.size).toBeGreaterThan(0);
    }
  }
  await retainedMetadata();
  await trigger.click();
  await panel
    .getByRole('button', { name: 'Refresh files', exact: true })
    .click();
  await expect(
    shared.getByText('initial-note.txt', { exact: false }),
  ).toBeVisible();
  await expect(
    shared.getByText('follow-up.md', { exact: false }),
  ).toBeVisible();
  await expect(shared.getByRole('link')).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Message Shared files', exact: true }),
  ).toBeVisible();
  await retainedMetadata();
  await trigger.click();
  await expect(
    shared.getByText('initial-note.txt', { exact: false }),
  ).toBeVisible();
  await expect(
    shared.getByText('follow-up.md', { exact: false }),
  ).toBeVisible();
  await expect(panel).toHaveCSS('opacity', '1');
  await mkdir('.context/screenshots', { recursive: true });
  await page.screenshot({
    path: `.context/screenshots/shared-files-${testInfo.project.name}.png`,
    fullPage: true,
    scale: 'css',
  });
  await panel.getByRole('button', { name: 'Close conversation files' }).click();
  const otherId = await createChat(page, 'Separate files');
  const otherFiles = await application(page).get(
    `/api/chats/${otherId}/shared-files`,
  );
  expect(otherFiles.status()).toBe(200);
  expect((await otherFiles.json()) as { files: Attachment[] }).toEqual({
    files: [],
  });
  await page
    .getByRole('button', { name: 'Conversation files', exact: true })
    .click();
  await expect(
    shared.getByRole('heading', { name: 'Shared with agent', exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('status', { name: 'Loading conversation files' }),
  ).not.toBeVisible();
  await expect(
    shared.getByText('initial-note.txt', { exact: false }),
  ).not.toBeVisible();
  await expect(
    shared.getByText('follow-up.md', { exact: false }),
  ).not.toBeVisible();
  await expect(shared.getByRole('link')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close conversation files' }).click();
  await goChat(page, chatId);
  await retainedMetadata();
});
