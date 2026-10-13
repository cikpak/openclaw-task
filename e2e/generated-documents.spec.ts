import { mkdir, readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { cleanChats, createChat, idle, login, send } from './helpers.js';
import type { Artifact } from '@messenger/contracts';

test('generated documents are scoped, listed and downloadable from Markdown without SPA navigation', async ({
  page,
}, info) => {
  expect(process.env.ACCEPTANCE_PROJECT).toMatch(
    /^messenger-acceptance-[a-z0-9-]+$/u,
  );
  await login(page);
  const models = await page.request.get('/api/models');
  expect(models.status()).toBe(200);
  expect(await models.text()).toContain('mock/test-model');
  await cleanChats(page.request);
  await page.reload();
  const chatId = await createChat(page, 'Generated document');
  await send(page, 'TOOL_WRITE_DOC_FIXTURE');
  await idle(page);
  const { artifacts } = (await (
    await page.request.get(`/api/chats/${chatId}/artifacts`)
  ).json()) as { artifacts: Artifact[] };
  const generated = artifacts.find(
    (artifact) => artifact.sourcePath === 'documents/artifact-fixture.txt',
  );
  expect(generated).toBeDefined();
  const tool = page.locator('[data-tool-id]').filter({
    has: page.getByRole('button', {
      name: 'write · completed · Tool details',
      exact: true,
    }),
  });
  await expect(tool).toHaveCount(1);
  await expect(page.getByText('Tool output', { exact: true })).toHaveCount(0);
  const trigger = tool.getByRole('button', {
    name: 'write · completed · Tool details',
    exact: true,
  });
  await expect(trigger).toHaveText('Write');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const details = page.getByRole('dialog', {
    name: 'write · completed · Tool details',
    exact: true,
  });
  await expect(details).toBeVisible();
  await expect(details).toHaveAttribute('popover', 'manual');
  expect(
    await details.evaluate((element) => element.closest('[data-tool-id]')),
  ).toBeNull();
  await expect(
    details.getByRole('heading', { name: 'Parameters', exact: true }),
  ).toBeVisible();
  await expect(details.getByText('Path', { exact: true })).toBeVisible();
  await expect(
    details.getByRole('heading', { name: 'Result', exact: true }),
  ).toBeVisible();
  const content = details
    .locator('details')
    .filter({ has: page.getByText('Document content', { exact: true }) });
  await expect(content).toHaveCount(1);
  const disclosure = content.locator(':scope > summary');
  await expect(disclosure.locator('svg')).toHaveAttribute('width', '16');
  await expect(disclosure.locator('svg')).toHaveAttribute('height', '16');
  await expect(disclosure.locator('svg')).toHaveAttribute(
    'viewBox',
    '0 0 24 24',
  );
  await expect(disclosure.locator('svg')).toHaveAttribute('fill', 'none');
  await expect(disclosure).toHaveCSS('list-style-type', 'none');
  await disclosure.click();
  await expect(
    content.getByText('TOOL_FILE_TOKEN', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Download generated document',
      exact: true,
    }),
  ).toBeVisible();
  const order = await page
    .getByRole('button', { name: 'Download generated document', exact: true })
    .evaluate((button) => {
      const tool = document.querySelector('[data-tool-id]');
      const final = button.closest('[data-message-role="assistant"]');
      return (
        !!tool &&
        !!final &&
        !!(
          tool.compareDocumentPosition(final) & Node.DOCUMENT_POSITION_FOLLOWING
        )
      );
    });
  expect(order).toBe(true);
  await page.keyboard.press('Escape');
  await expect(details).not.toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
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
    panel.getByRole('link', { name: /artifact-fixture\.txt/u }),
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
  await panel.getByRole('link', { name: /artifact-fixture\.txt/u }).click();
  const same = await sidebarDownload;
  expect(await readFile(await same.path(), 'utf8')).toBe('TOOL_FILE_TOKEN');
  const other = await createChat(page, 'Different document chat');
  expect(
    (
      await page.request.get(`/api/chats/${other}/artifacts/${generated!.id}`)
    ).status(),
  ).toBe(404);
  expect(
    (
      await page.request.get(
        `/api/chats/${chatId}/artifacts/resolve?path=${encodeURIComponent('../auth-profiles.json')}`,
      )
    ).status(),
  ).toBe(404);
});
