import { defineConfig } from '@playwright/test';

// Browser tests are named *.spec.ts so the root `node --test` run never collects them.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // Kept under node_modules so failure traces never show up as repository structure.
  outputDir: './node_modules/.playwright/test-results',
  use: { baseURL: 'http://localhost:5173' },
  webServer: { command: 'pnpm dev', url: 'http://localhost:5173', reuseExistingServer: true },
});
