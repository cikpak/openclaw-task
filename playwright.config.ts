import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  outputDir: '.context/playwright-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: '.context/playwright-report', open: 'never' }],
  ],
  use: {
    baseURL:
      process.env.ACCEPTANCE_ORIGIN ??
      `http://localhost:${process.env.ACCEPTANCE_PORT ?? 18080}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
