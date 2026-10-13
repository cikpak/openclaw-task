import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Package suites own their app tests; root gates own deploy policy checks only.
    include: ['deploy/**/*.test.mjs'],
  },
});
