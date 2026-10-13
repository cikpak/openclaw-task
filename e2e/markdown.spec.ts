import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { cleanChats, createChat, idle, login, send } from './helpers.js';

test('native streamed assistant Markdown renders readable structure without replacing its content shell', async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  expect(process.env.ACCEPTANCE_PROJECT).toMatch(
    /^messenger-acceptance-[a-z0-9-]+$/u,
  );
  await login(page);
  const response = await page.request.get('/api/models');
  expect(response.status()).toBe(200);
  expect(
    ((await response.json()) as { models: Array<{ id: string }> }).models.some(
      (model) => model.id === 'mock/test-model',
    ),
  ).toBe(true);
  await cleanChats(page.request);
  await createChat(page, 'Markdown replies');
  await send(
    page,
    'MARKDOWN_STYLE_FIXTURE Show the education and skills summary.',
  );
  const live = page.locator(
    '[data-message-state="active"][data-message-role="assistant"] [data-message-content]',
  );
  await expect(live).toBeVisible();
  await live.evaluate((element) =>
    Object.assign(window, { markdownContentShell: element }),
  );
  const firstLength = await live.evaluate(
    (element) => element.textContent?.length ?? 0,
  );
  await expect
    .poll(() => live.evaluate((element) => element.textContent?.length ?? 0), {
      intervals: [50],
    })
    .toBeGreaterThan(firstLength);
  expect(
    await live.evaluate(
      (element) =>
        element ===
        (window as unknown as { markdownContentShell: Element })
          .markdownContentShell,
    ),
    'Text deltas preserve the Markdown content shell',
  ).toBe(true);
  await idle(page);
  const reply = page
    .locator('[data-message-state="canonical"][data-message-role="assistant"]')
    .last();
  const content = reply.locator('[data-message-content]');
  await expect(content).toBeVisible();
  expect(
    await content.evaluate(
      (element) =>
        element ===
        (window as unknown as { markdownContentShell: Element })
          .markdownContentShell,
    ),
    'Canonical history reuses the streamed Markdown content shell',
  ).toBe(true);
  await expect(content.locator('ul')).toHaveCount(1);
  await expect(content.locator('ul > li')).toHaveCount(2);
  await expect(content.locator('li').first().locator('strong')).toHaveText(
    'Chisinau Politechnical College:',
  );
  await expect(content.locator('li').last().locator('strong')).toHaveText(
    'Step IT Academy:',
  );
  await expect(content.locator('li').first()).toHaveText(
    'Chisinau Politechnical College: Computer Science, June 2018.',
  );
  await expect(content.locator('li').last()).toHaveText(
    'Step IT Academy: Computer Science, December 2019.',
  );
  await expect(
    content.getByRole('heading', {
      level: 3,
      name: 'Skills and tools',
      exact: true,
    }),
  ).toBeVisible();
  await expect(content.locator('p > strong')).toHaveText('Overall:');
  await expect(content.locator('p')).toHaveCount(3);
  await expect(content.locator('p').last()).toHaveText(
    'Overall: It presents an engineer who combines product development and frontend leadership with substantial experience teaching others.',
  );
  await expect(content).toContainText(
    'Covers JavaScript/TypeScript, React, Vue, Next.js, HTML/CSS, Node.js, Python, SQL, MongoDB, APIs, microservices, and CI/CD.',
  );
  await expect(content).toContainText(
    'The header includes a phone number, email address, and LinkedIn reference.',
  );
  await expect(content).not.toContainText('**');
  await expect(content).not.toContainText('###');
  const sizes = await content.evaluate((element) => {
    const heading = element.querySelector('h3')!;
    const paragraphs = Array.from(element.querySelectorAll(':scope > p'));
    const bubble = element.closest('[data-message-id]')!;
    const column = bubble.parentElement!;
    return {
      heading: parseFloat(getComputedStyle(heading).fontSize),
      line: parseFloat(getComputedStyle(paragraphs[0]!).lineHeight),
      margins: paragraphs.map((paragraph) =>
        parseFloat(getComputedStyle(paragraph).marginBottom),
      ),
      bubble: bubble.getBoundingClientRect().width,
      column: column.getBoundingClientRect().width,
    };
  });
  expect(sizes.heading).toBeLessThanOrEqual(20);
  expect(sizes.heading).toBeGreaterThanOrEqual(16);
  expect(sizes.line).toBeGreaterThanOrEqual(24);
  expect(
    sizes.margins.some((margin) => margin > 0),
    'Separate paragraphs have readable spacing',
  ).toBe(true);
  expect(sizes.bubble).toBeLessThanOrEqual(sizes.column * 0.85 + 1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    'Markdown does not create horizontal page overflow',
  ).toBe(true);
  expect(
    await content.evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
  ).not.toBe('none');
  await content.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  await mkdir('.context/screenshots', { recursive: true });
  await page.screenshot({
    path: `.context/screenshots/markdown-${testInfo.project.name}.png`,
    fullPage: true,
    scale: 'css',
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(content).toHaveCSS('animation-name', 'none');
});
