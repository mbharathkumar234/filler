import { defineConfig } from '@playwright/test';

/**
 * E2E runs against locally served fixture pages only — never a live portal.
 * See §6.1: "Manual portal smoke tests" are a human, pre-release activity.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0, // Flakiness here is a real defect (§ Phase 6 Verify), not test noise.
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run fixtures:serve',
    url: 'http://localhost:4173/',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
});
