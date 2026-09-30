import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  outputDir: '/tmp/opencontext-web-playwright-results',
  reporter: 'list',
  use: {
    baseURL: process.env['OPENCONTEXT_E2E_URL'] ?? 'http://127.0.0.1:4310',
    trace: 'retain-on-failure',
    launchOptions: process.env['OPENCONTEXT_BROWSER_BINARY']
      ? { executablePath: process.env['OPENCONTEXT_BROWSER_BINARY'] }
      : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
