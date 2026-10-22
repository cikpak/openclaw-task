import { observeStream, type StreamEvidence } from './stream-observer.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import { createChat, idle, send } from './helpers.js';
import { syntheticAccount, box, sameBounds } from './polish-helpers.js';
test('real incremental text stays chronological, readable and reader-controlled', async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  if (testInfo.project.name === 'desktop')
    await page.setViewportSize({ width: 960, height: 900 });
  await observeStream(page);
  await syntheticAccount(page);
  await createChat(page, 'Streaming polish');
  const longText =
    `First chronological question ${'unbroken-text-'.repeat(100)}\n${'Readable line in a long message.\n'.repeat(40)}`.trimEnd();
  await send(page, longText);
  await idle(page);
  const composer = page.getByRole('textbox', {
    name: 'Message Streaming polish',
    exact: true,
  });
  const form = composer.locator('..');
  const action = form.getByRole('button', {
    name: 'Send message',
    exact: true,
  });
  const idleBounds = await box(action);
  await page.evaluate(() => {
    const state = (window as unknown as { polishStream: StreamEvidence })
      .polishStream;
    state.frames = [];
    state.paints = [];
    state.terminalAt = null;
    delete (window as unknown as { polishReplyNode?: Element }).polishReplyNode;
  });
  const secondPrompt =
    'DELAY_RESPONSE_FIXTURE Second chronological question TEXT_FIXTURE_TOKEN MARKDOWN_FIXTURE_TOKEN PDF_FIXTURE_TOKEN';
  const finalReply =
    'Real Gateway integration response. TEXT_FIXTURE_TOKEN MARKDOWN_FIXTURE_TOKEN PDF_FIXTURE_TOKEN';
  await send(page, secondPrompt);
  const thinking = page.getByRole('status', { name: 'Agent is thinking' });
  await expect(thinking).toBeVisible();
  const liveBubble = thinking.locator('..');
  expect(
    await liveBubble.evaluate(
      (element) => element.parentElement?.lastElementChild === element,
    ),
    'Thinking is the final transcript element, after submitted input',
  ).toBe(true);
  await expect(liveBubble).toHaveCSS('border-top-width', '0px');
  const shimmer = await thinking
    .locator('span')
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(shimmer).not.toBe('none');
  const queue = form.getByRole('button', {
    name: 'Queue message',
    exact: true,
  });
  sameBounds(idleBounds, await box(queue));
  const mode = form.getByRole('combobox', { name: 'Send behavior' });
  await mode.click();
  await page
    .getByRole('option', { name: 'Steer current run', exact: true })
    .click();
  const steer = form.getByRole('button', { name: 'Steer agent', exact: true });
  sameBounds(idleBounds, await box(steer));
  const modeBounds = await box(mode);
  const steerBounds = await box(steer);
  expect(
    Math.abs(
      modeBounds.y +
        modeBounds.height / 2 -
        steerBounds.y -
        steerBounds.height / 2,
    ),
  ).toBeLessThanOrEqual(1);
  const history = page.locator('[data-message-id]').first().locator('../..');
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { polishStream: StreamEvidence }).polishStream
              .paints.length,
        ),
      { intervals: [20] },
    )
    .toBeGreaterThanOrEqual(1);
  expect(
    await page
      .locator('[data-message-state="active"] > [data-message-content]')
      .evaluate((element) => getComputedStyle(element).animationName),
  ).not.toBe('none');
  await history.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(thinking).not.toBeVisible();
  await idle(page);
  expect(
    await history.evaluate((element) => element.scrollTop),
    'Streaming does not pull a reader off older content',
  ).toBeLessThanOrEqual(1);
  await page
    .getByRole('button', { name: 'Jump to latest', exact: true })
    .click();
  await expect
    .poll(() =>
      history.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect
    .poll(() => page.locator('[data-message-state="canonical"]').count())
    .toBe(4);
  const messages = page.locator('[data-message-state="canonical"]');
  for (const message of await messages.all()) {
    await expect(message).toHaveCSS('border-top-width', '0px');
    await expect(message).toHaveCSS('border-left-width', '0px');
  }
  const ordered = await messages.evaluateAll((elements) =>
    elements.map((element) => ({
      role: element.getAttribute('data-message-role'),
      text: element.querySelector('[data-message-content]')?.textContent,
    })),
  );
  expect(ordered.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
  expect(ordered[0]?.text).toBe(longText);
  expect(ordered[2]?.text).toBe(secondPrompt);
  expect(ordered[1]?.text).toBe('Real Gateway integration response.');
  expect(ordered[3]?.text).toBe(finalReply);
  const bubbles = await messages.evaluateAll((elements) =>
    elements.map((element) => {
      const bubble = element.getBoundingClientRect();
      const column = element.parentElement!.getBoundingClientRect();
      return {
        role: element.getAttribute('data-message-role'),
        width: bubble.width,
        column: column.width,
        left: bubble.left - column.left,
        right: column.right - bubble.right,
      };
    }),
  );
  for (const bubble of bubbles) {
    expect(bubble.width).toBeLessThanOrEqual(bubble.column * 0.85 + 1);
    expect(
      Math.abs(bubble.role === 'user' ? bubble.right : bubble.left),
    ).toBeLessThanOrEqual(1);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const evidence = await page.evaluate(
    () => (window as unknown as { polishStream: StreamEvidence }).polishStream,
  );
  await writeFile(
    `.context/chat-polish-stream-${testInfo.project.name}.json`,
    JSON.stringify({ evidence, idleBounds, steerBounds, bubbles }, null, 2),
  );
  expect(evidence.frames.length).toBeGreaterThanOrEqual(2);
  const partials = evidence.paints.filter(
    (paint) => paint.size < finalReply.length,
  );
  expect(
    partials[0]?.inView,
    'First partial response is visibly painted before scrolling away',
  ).toBe(true);
  expect(
    new Set(partials.map((paint) => paint.size)).size,
  ).toBeGreaterThanOrEqual(2);
  expect(
    partials[0]?.delay,
    'Frame-to-foreground partial paint',
  ).toBeLessThanOrEqual(150);
  expect(
    partials.every((paint) => paint.matchesFrame),
    'No fabricated character-at-a-time updates',
  ).toBe(true);
  expect(evidence.terminalAt).not.toBeNull();
  expect(
    evidence.paints.every((paint) => paint.sameNode),
    'Streaming deltas preserve the animated reply node',
  ).toBe(true);
  const finalContent = page
    .locator(
      '[data-message-state="canonical"][data-message-role="assistant"] > [data-message-content]',
    )
    .last();
  expect(
    await finalContent.evaluate(
      (element) =>
        element ===
        (window as unknown as { polishReplyNode?: Element }).polishReplyNode,
    ),
    'Canonical handoff preserves the animated reply node',
  ).toBe(true);
  expect(partials.every((paint) => paint.at < evidence.terminalAt!)).toBe(true);
  await mkdir('.context/screenshots', { recursive: true });
  await page.screenshot({
    path: `.context/screenshots/chat-polish-${testInfo.project.name}.png`,
    fullPage: true,
    scale: 'css',
  });
  await writeFile(
    `.context/chat-polish-stream-${testInfo.project.name}.json`,
    JSON.stringify({ evidence, idleBounds, steerBounds, bubbles }, null, 2),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(finalContent).toHaveCSS('animation-name', 'none');
});
