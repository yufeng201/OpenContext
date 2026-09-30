import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/integration/**/*.test.ts',
      'apps/web/tests/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      'plugins/*/tests/**/*.test.ts',
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: 2,
  },
});
