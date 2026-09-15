import { defineConfig, devices } from '@playwright/test';

import { browserRenderer } from './scripts/browser-renderer';

/**
 * P16 T2 – porovnání modelů a úsilí nad vykresleným světem.
 *
 * **Žádný `webServer`:** každá varianta má vlastní `next start` na vlastním
 * portu (`scripts/effort-servers.mjs --start`) a spec si port bere z
 * `variants.json`. Server postavený odsud by byl jedna varianta, ne sedm.
 *
 * Souběh variant řídí `WORLDSMITH_EFFORT_CONCURRENCY` (výchozí 2): jeden test
 * je jedna varianta a jde svými větami za sebou, takže víc workerů znamená víc
 * variant naráz, tedy i víc souběžných volání na předplatné.
 */
const concurrency = Number(process.env.WORLDSMITH_EFFORT_CONCURRENCY ?? '2');

export default defineConfig({
  testDir: './e2e',
  testMatch: /effort-compare\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 2,
  reporter: [['list']],
  use: {
    trace: 'off',
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: browserRenderer().args },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } }],
});
