import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

/**
 * Vzhled P56B naživo: 12 vět auditu 21. 10. (`evals/play/p56b/sentences.json`) a věta na žánr
 * (`evals/play/p46g/genres.json`) projdou skutečnými dveřmi `POST /api/play/games`, ukázka robota
 * se odtiká ručními hodinami do tiku 150 (jako `scripts/play-look-shots.mjs shots`).
 *
 * T3: žádná 404 na `/assets/`. Chybějící model se kreslí jako náhradní kvádr a hra jinak běží,
 * takže na pohled to nikdo nepozná – audit naměřil 19× 404 na `rigged:*-lod1.glb`.
 */

interface Sentence {
  readonly id: string;
  readonly text: string;
}

const setOf = (path: string): readonly Sentence[] => (JSON.parse(readFileSync(join(process.cwd(), path), 'utf8')) as { sentences: Sentence[] }).sentences;
const SENTENCES = [...setOf('evals/play/p56b/sentences.json'), ...setOf('evals/play/p46g/genres.json')];
const TICKS = 150;

interface HandShell {
  byHand(on: boolean): void;
  tickByHand(): { readonly tick: number; readonly runState: string };
}

/** Modely dotažené: počet sítí scény se 1,5 s nezměnil (jako `settle` ve skriptu snímků). */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => (window.__playRender?.().calls ?? 0) > 0, undefined, { timeout: 60_000 });
  let last = -1;
  let since = Date.now();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const meshes = await page.evaluate(() => window.__playRender!().meshes);
    if (meshes !== last) {
      last = meshes;
      since = Date.now();
    } else if (Date.now() - since >= 1500) return;
    await page.waitForTimeout(250);
  }
}

/** Ukázka robota odtikaná ručními hodinami do `TICKS` – těla, která přijdou později, si dotáhnou modely. */
async function demoTo(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (window.__playShell as unknown as HandShell | undefined)?.byHand === 'function', undefined, { timeout: 30_000 });
  await page.evaluate(() => (window.__playShell as unknown as HandShell).byHand(true));
  await page.getByTestId('play-pause').click();
  await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
  await page.evaluate((count) => {
    for (let index = 0; index < count; index += 1) {
      if ((window.__playShell as unknown as HandShell).tickByHand().runState !== 'running') break;
    }
  }, TICKS);
}

test('no model request 404s and no fallback piece across the audit sentences and one sentence per genre', async ({ page, request }) => {
  test.setTimeout(SENTENCES.length * 120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const missing: string[] = [];
  // T10: tělo, které po dotažení modelů kreslí náhradní díl (`data-fallback` na `arcade-stage`, `World.tsx`).
  const fallbacks: string[] = [];
  const unprobed: string[] = [];
  let current = '';
  page.on('response', (response) => {
    if (response.status() === 404 && response.url().includes('/assets/')) missing.push(`${current}: ${new URL(response.url()).pathname}`);
  });
  for (const sentence of SENTENCES) {
    current = sentence.id;
    const response = await request.post('/api/play/games', { data: { sentence: sentence.text } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const { url } = (await response.json()) as { url: string };
    await page.goto(url);
    await page.locator('canvas').first().waitFor({ timeout: 60_000 });
    await settle(page);
    await demoTo(page);
    await settle(page);
    const probe = await page.getByTestId('arcade-stage').evaluate((stage: HTMLElement) => ({ count: stage.dataset.fallback, ids: stage.dataset.fallbackIds }));
    if (probe.count === undefined) unprobed.push(sentence.id);
    else if (probe.count !== '0') fallbacks.push(`${sentence.id}: ${probe.count} (${probe.ids})`);
  }
  expect(missing).toEqual([]);
  expect(fallbacks).toEqual([]);
  // Sondu zapisuje scéna, která vepisuje model (`FittedModel`); rytmus, souboj, načasování, střelnice,
  // hod a míč kreslí vlastní tvary a sondu nemají – většina sady ji ale nést musí, jinak nula nic neříká.
  expect(unprobed.length, unprobed.join(' ')).toBeLessThanOrEqual(SENTENCES.length / 3);
});

test('the fallback probe counts bodies whose model is missing', async ({ page, request }) => {
  test.setTimeout(120_000);
  const kits = (JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/look/obstacle-kits.json'), 'utf8')) as { kits: Record<string, Record<string, string>> }).kits;
  const kitModels = new Set(Object.values(kits).flatMap((kit) => Object.values(kit)));
  // Díly sad „chybí“: každý model kitu vrátí 404, tělo s ním musí skončit v sondě.
  await page.route(/\/assets\/.*\.glb$/, (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop()!.replace(/-lod[01]\.glb$/, '');
    return kitModels.has(file) ? route.fulfill({ status: 404, body: '' }) : route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  const ghost = SENTENCES.find((sentence) => sentence.id === '12-ghost')!;
  const response = await request.post('/api/play/games', { data: { sentence: ghost.text } });
  const { url } = (await response.json()) as { url: string };
  await page.goto(url);
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  await settle(page);
  await demoTo(page);
  await settle(page);
  const probe = await page.getByTestId('arcade-stage').evaluate((stage: HTMLElement) => ({ count: Number(stage.dataset.fallback), ids: stage.dataset.fallbackIds ?? '' }));
  expect(probe.count).toBeGreaterThan(0);
  expect(probe.ids.split(' ').every((id) => kitModels.has(id)), probe.ids).toBe(true);
});
