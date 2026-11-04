import { defineConfig } from '@playwright/test';

import { browserRenderer } from '../../../scripts/browser-renderer';

/**
 * P70A T4: průchod začátečníka v prohlížeči nad už běžícím `next start` (port `E2E_PORT`, výchozí 3201 – 3000 drží
 * demo majitele). Server se tu nestaví ani nespouští: měří se build, který leží v `.next/` tohoto worktree.
 *
 *   E2E_PORT=3201 npx playwright test --config evals/play/p70a/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /browser\.spec\.ts/,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../../test-results/p70a',
  use: {
    baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? '3201'}`,
    trace: 'off',
    launchOptions: { args: [...browserRenderer().args, '--disable-features=OpenXR'] },
  },
});
