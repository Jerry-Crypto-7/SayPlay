import { join } from 'node:path';

import { type Page, expect, test } from '@playwright/test';

/**
 * Instalace jako aplikace (P67 T11): service worker se zaregistruje jen v prohlížeči, který umí immersive VR
 * (emulátor IWER, Quest 2), a stránka pod ním dál normálně běží, protože jen propouští síť. Chromium bez emulátoru
 * je telefon nebo desktop: tam se nezaregistruje nic.
 */

const IWER_BUNDLE = join(process.cwd(), 'node_modules/iwer/build/iwer.min.js');

declare global {
  interface Window {
    IWER?: { XRDevice: new (config: unknown) => { installRuntime(options?: { forceInstall?: boolean }): void }; metaQuest2: unknown };
  }
}

async function withQuest2(page: Page): Promise<void> {
  await page.addInitScript({ path: IWER_BUNDLE });
  await page.addInitScript(() => {
    new window.IWER!.XRDevice(window.IWER!.metaQuest2).installRuntime({ forceInstall: true });
  });
}

const registration = (page: Page): Promise<string | null> =>
  page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/play'))?.scope ?? null);

test('a headset browser registers the pass-through worker and the page keeps working under it', async ({ page }) => {
  await withQuest2(page);
  await page.goto('/play');
  await expect.poll(() => registration(page), { timeout: 15_000 }).toMatch(/\/play$/);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 15_000 }).toBe(true);

  // Pod workerem: nová návštěva i požadavek na API jdou na síť a vrátí čerstvou odpověď.
  const response = await page.reload();
  expect(response?.status()).toBeLessThan(400);
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const created = await page.evaluate(async () => {
    const answer = await fetch('/api/play/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: 'A penguin slides down an icy hill collecting fish.' }) });
    return answer.status;
  });
  expect(created).toBeLessThan(300);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});

test('a browser without immersive VR registers no worker', async ({ page }) => {
  await page.goto('/play');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  expect(await registration(page)).toBeNull();
});
