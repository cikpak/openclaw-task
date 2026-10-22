import { mockManager } from './manager-fixtures.js';
import { application } from './manager-client.js';
import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { cleanChats, createChat, idle, login } from './helpers.js';

test('files sidetab loads in place, closes accessibly and keeps chat geometry stable', async ({
  page,
}, testInfo) => {
  expect(process.env.ACCEPTANCE_PROJECT).toMatch(
    /^messenger-acceptance-[a-z0-9-]+$/u,
  );
  await login(page);
  const modelsReply = await application(page).get('/api/models?refresh=true');
  expect(modelsReply.ok()).toBe(true);
  const catalog = (await modelsReply.json()) as {
    models: Array<{ id: string }>;
  };
  expect(catalog.models.some((model) => model.id === 'mock/test-model')).toBe(
    true,
  );
  await cleanChats(page);
  await createChat(page, 'Files panel');
  // Creation acknowledges durable acceptance before native materialization.
  // Isolate file-panel caching from that legitimate later catalog invalidation.
  await idle(page);
  const reads = { agent: 0, shared: 0 };
  let failAgent = false;
  let snapshotReady = false;
  await mockManager(
    page,
    async (command) => {
      if (command.type !== 'files.list') return undefined;
      const generated = command.category === 'generated';
      reads[generated ? 'agent' : 'shared']++;
      await new Promise((resolve) =>
        setTimeout(resolve, generated ? 700 : 1300),
      );
      if (generated && failAgent)
        return {
          error: {
            type: 'about:blank',
            title: 'Agent file refresh unavailable',
            status: 503,
            detail: 'Agent file refresh unavailable.',
            code: 'fixture',
            correlationId: 'synthetic-files',
          },
        };
      return {
        files: [
          {
            id: generated ? 'fixture-file' : 'synthetic-upload',
            name: generated ? 'notes.txt' : 'sent-notes.txt',
            mimeType: 'text/plain',
            sizeBytes: 2048,
            category: generated ? 'deliverable' : 'input',
            updatedAt: Date.now(),
          },
        ],
      };
    },
    (result, command) => {
      if (
        result.ok &&
        command?.type === 'conversation.recent.request' &&
        result.data.snapshot
      )
        snapshotReady = true;
      return result;
    },
  );
  await page.reload();
  await expect.poll(() => snapshotReady).toBe(true);
  await idle(page);
  await expect(
    page.getByText('Loading conversation…', { exact: true }),
  ).not.toBeVisible();
  const composer = page.getByRole('textbox', {
    name: 'Message Files panel',
    exact: true,
  });
  await composer.fill('Keep this draft');
  const before = await composer.boundingBox();
  const trigger = page.getByRole('button', {
    name: 'Conversation files',
    exact: true,
  });
  const panel = page.getByRole('region', {
    name: 'Conversation files',
    exact: true,
  });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).not.toBeVisible();
  expect(reads).toEqual({ agent: 0, shared: 0 });
  await trigger.click();
  await expect(
    panel.getByRole('status', { name: 'Loading conversation files' }),
  ).toBeVisible();
  await expect(panel.getByRole('status').locator('svg')).toHaveCSS(
    'width',
    '16px',
  );
  await expect(panel.getByRole('status').locator('svg')).toHaveCSS(
    'height',
    '16px',
  );
  await expect(panel.getByRole('status').locator('svg')).toHaveAttribute(
    'viewBox',
    '0 0 24 24',
  );
  expect(
    await panel
      .getByRole('status')
      .locator('span[aria-hidden="true"]')
      .evaluate((element) => getComputedStyle(element).animationName),
  ).not.toBe('none');
  await expect(
    panel.getByText('Files shared by this agent will appear here.'),
  ).not.toBeVisible();
  await panel.getByRole('button', { name: 'Close conversation files' }).click();
  await expect(trigger).toBeFocused();
  await expect(panel).not.toBeVisible();
  await trigger.click();
  await expect(panel.getByRole('button', { name: /notes.txt/u })).toBeVisible();
  const shared = panel.getByRole('region', {
    name: 'Shared with agent',
    exact: true,
  });
  const agent = panel.getByRole('region', { name: 'From agent', exact: true });
  await expect(
    shared.getByText('sent-notes.txt', { exact: false }),
  ).toBeVisible();
  await expect(shared.getByRole('link')).toHaveCount(0);
  await expect(
    agent.getByRole('button', { name: /notes.txt/u }),
  ).toHaveAttribute('type', 'button');
  await expect(
    panel.getByRole('status', { name: 'Loading conversation files' }),
  ).not.toBeVisible();
  expect(reads).toEqual({ agent: 1, shared: 1 });
  failAgent = true;
  await panel
    .getByRole('button', { name: 'Refresh files', exact: true })
    .click();
  await expect(agent.getByRole('alert')).toContainText(
    'Agent file refresh unavailable',
  );
  await expect(
    shared.getByText('sent-notes.txt', { exact: false }),
  ).toBeVisible();
  await expect(agent.getByRole('button', { name: /notes.txt/u })).toBeVisible();
  expect(reads).toEqual({ agent: 2, shared: 2 });
  failAgent = false;
  await agent
    .getByRole('button', { name: 'Retry agent files', exact: true })
    .click();
  await expect(agent.getByRole('alert')).not.toBeVisible();
  await expect(
    agent.getByRole('button', { name: 'Retry agent files', exact: true }),
  ).not.toBeVisible();
  expect(reads).toEqual({ agent: 3, shared: 2 });
  await expect(composer).toHaveValue('Keep this draft');
  expect(await composer.boundingBox()).toEqual(before);
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await panel.getByRole('button', { name: 'Close conversation files' }).focus();
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS('transition-duration', '0s');
  expect(reads).toEqual({ agent: 3, shared: 2 });
  await expect(composer).toHaveValue('Keep this draft');
  expect(await composer.boundingBox()).toEqual(before);
  await mkdir('.context/screenshots', { recursive: true });
  await page.screenshot({
    path: `.context/screenshots/files-panel-${testInfo.project.name}.png`,
    fullPage: true,
    scale: 'css',
  });
});
