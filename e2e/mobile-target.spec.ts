import { expect, test } from '@playwright/test';
import { mobileTarget } from './helpers.js';

const fixture = `<button style="all:unset;display:block;box-sizing:border-box;
  position:fixed;top:16.1234px;left:16.1234px;width:44px;height:44px">
  Dismiss notification</button>`;

test('44px mobile targets tolerate Chromium box-coordinate precision', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(fixture);
  const button = page.getByRole('button', { name: 'Dismiss notification' });
  // Force the same ~8e-6px float32 undershoot observed in the CI toast bounds.
  await button.evaluate((element) => {
    element.style.transform = 'scale(0.99999982660467)';
  });
  expect(
    await button.evaluate((element) => getComputedStyle(element).height),
  ).toBe('44px');
  expect(
    await button.evaluate((element) => getComputedStyle(element).width),
  ).toBe('44px');
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThan(44);
  expect(box!.height).toBeLessThan(44);
  expect(box!.width).toBeGreaterThan(43.9999);
  expect(box!.height).toBeGreaterThan(43.9999);
  await mobileTarget(page, button);
});

for (const dimension of ['width', 'height'] as const) {
  test(`genuinely undersized mobile target ${dimension} still fails`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const size of [43.99, 43]) {
      await page.setContent(fixture);
      const button = page.getByRole('button', { name: 'Dismiss notification' });
      await button.evaluate(
        (element, input) => {
          element.style[input.dimension] = `${input.size}px`;
        },
        { dimension, size },
      );
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box![dimension]).toBeLessThan(43.9999);
      await expect(mobileTarget(page, button)).rejects.toThrow(
        `Mobile target ${dimension}`,
      );
    }
  });
}
