/**
 * Prohlížeč stahuje Rapier jen ke hře s fyzikou (P29A R6). `physics-lazy.test.ts`
 * hlídá logiku v Node; tady se počítá, co opravdu přišlo po síti: arkádová hra
 * bez fyziky nesmí dostat žádný skript s Rapierem (ani `.wasm`), laboratoř
 * s fyzikálním kamenem ano. Rapier se pozná podle jména vazby z wasm-bindgen,
 * které minifikace nepřejmenuje.
 *
 * Server musí běžet s `PLAY_LAB=1` (laboratoř je jinak v produkci 404).
 */

import { expect, test, type Page } from '@playwright/test';

const RAPIER_MARKER = 'rawintegrationparameters_new';

/** Po načtení stránky: kolik stažených skriptů nese Rapier a kolik `.wasm`. */
function watchRapier(page: Page): () => Promise<{ scripts: number; wasm: number }> {
  const bodies: Promise<boolean>[] = [];
  let wasm = 0;
  page.on('response', (response) => {
    const url = response.url();
    if (url.endsWith('.wasm')) wasm += 1;
    if (response.request().resourceType() === 'script') bodies.push(response.text().then((text) => text.includes(RAPIER_MARKER), () => false));
  });
  return async () => ({ scripts: (await Promise.all(bodies)).filter(Boolean).length, wasm });
}

test('an arcade game without physics never fetches Rapier', async ({ page, request }) => {
  const published = await request.post('/api/play/games', { data: { sentence: 'jumping arcade game with a lot of obstacles' } });
  expect(published.status(), await published.text()).toBeLessThan(300);
  const { url } = (await published.json()) as { url: string };
  const seen = watchRapier(page);
  await page.goto(url);
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 30, undefined, { timeout: 60_000 });
  await page.waitForTimeout(1_000);
  expect(await seen()).toEqual({ scripts: 0, wasm: 0 });
});

test('the physics lab fetches the Rapier chunk', async ({ page }) => {
  const seen = watchRapier(page);
  await page.goto('/play/lab/rules?f=throw-rock-physics');
  await expect(page.getByTestId('rules-lab')).toBeVisible({ timeout: 60_000 });
  expect((await seen()).scripts).toBeGreaterThan(0);
});
