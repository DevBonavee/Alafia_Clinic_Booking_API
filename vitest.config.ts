import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setupEnv.ts'],
    // All test files share one database, so they run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
