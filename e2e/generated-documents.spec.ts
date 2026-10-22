import { application, managerCommand } from './manager-client.js';
import { mkdir, readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { cleanChats, createChat, idle, login, send } from './helpers.js';
import type { BrowserFile } from '@messenger/contracts';

test('generated documents are scoped, listed and downloadable from Markdown without SPA navigation', async ({
  page,
}, info) => {
  expect(process.env.ACCEPTANCE_PROJECT).toMatch(
    /^messenger-acceptance-[a-z0-9-]+$/u,
  );
  await login(page);
  const models = await application(page).get('/api/models?refresh=true');
  expect(models.status()).toBe(200);
  expect(await models.text()).toContain('mock/test-model');
  await cleanChats(page);
  await page.reload();
  const chatId = await createChat(page, 'Generated document');
  await send(page, 'TOOL_WRITE_DOC_FIXTURE');
  await idle(page);
  const { artifacts } = (await (
    await application(page).get(`/api/chats/${chatId}/artifacts`)
  ).json()) as { artifacts: BrowserFile[] };
  const generated = artifacts.find(
    (artifact) => artifact.name === 'artifact-fixture.txt',
  );
  expect(generated).toBeDefined();
  expect(generated?.id).toMatch(/^[A-Za-z0-9_-]+$/u);
  expect(generated).not.toHaveProperty('sourcePath');
  await expect(page.locator('[data-tool-id]')).toHaveCount(1);
  await expect(page.locator('main')).not.toContainText('/recovery/');
  await expect(page.locator('main')).not.toContainText('auth-profiles.json');
  await expect(
    page.getByRole('button', {
      name: 'Download generated document',
      exact: true,
    }),
  ).toBeVisible();
  const before = page.url();
  const clicked = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download generated document', exact: true })
    .click();
  const download = await clicked;
  expect(download.suggestedFilename()).toBe('artifact-fixture.txt');
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(await readFile(path, 'utf8')).toBe('TOOL_FILE_TOKEN');
  expect(page.url()).toBe(before);
  await page
    .getByRole('button', { name: 'Conversation files', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'From agent', exact: true });
  await expect(
    panel.getByRole('button', { name: /artifact-fixture\.txt/u }),
  ).toBeVisible();
  await page
    .getByRole('region', { name: 'Conversation files', exact: true })
    .evaluate(async (panel) => {
      await Promise.all(
        panel
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      );
    });
  await mkdir('.context/screenshots', { recursive: true });
  await page.screenshot({
    path: `.context/screenshots/generated-document-${info.project.name}.png`,
    fullPage: true,
  });
  const sidebarDownload = page.waitForEvent('download');
  await panel.getByRole('button', { name: /artifact-fixture\.txt/u }).click();
  const same = await sidebarDownload;
  expect(await readFile(await same.path(), 'utf8')).toBe('TOOL_FILE_TOKEN');
  await page.reload();
  await expect(page.locator('[data-tool-id]')).toHaveCount(1);
  await expect(page.locator('main')).not.toContainText('/recovery/');
  await expect(page.locator('main')).not.toContainText('auth-profiles.json');
  const other = await createChat(page, 'Different document chat');
  const foreign = await managerCommand(page, {
    type: 'files.resolve',
    commandId: crypto.randomUUID(),
    chatId: other,
    fileId: generated!.id,
  });
  expect(foreign.ok).toBe(false);
  if (!foreign.ok) expect(foreign.error.status).toBe(404);
  // Native path resolution is absent; arbitrary strings cannot become file capabilities.
  const privateFile = await managerCommand(page, {
    type: 'files.resolve',
    commandId: crypto.randomUUID(),
    chatId,
    fileId: '../auth-profiles.json',
  });
  expect(privateFile.ok).toBe(false);
});
