import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * Galerie kulis draftu (P28D T5, F-28): deset vět zmrazené sady `judge-10.json`
 * projde skutečnými dveřmi `POST /api/play/games` (draft bez modelu) a každá
 * hra se vyfotí po usazení scény. Snímky jsou podklad pro lidské oko – žádný
 * atribut tu nerozhoduje, jestli kulisa vypadá rozbitě.
 *
 * **Běží jen na zavolání:** bez `P28_SCENERY_DIR` se přeskočí.
 */

const DIR = process.env.P28_SCENERY_DIR ?? '';

interface Sentence {
  readonly id: string;
  readonly text: string;
}

// Navíc věta ze snímků auditu (`custom-dragon-*.png`) a jedna hra gridu – ta kreslí svět přes `buildProxyWorldFrom`.
const SENTENCES: readonly Sentence[] = [
  ...(JSON.parse(readFileSync(join(process.cwd(), 'evals/play/fidelity/judge-10.json'), 'utf8')) as { sentences: Sentence[] }).sentences,
  { id: 'x-dragon', text: 'A knight rides a dragon over a burning castle and must pop ten balloons.' },
  { id: 'x-grid', text: 'Collect five glowing mushrooms then open a portal.' },
];

test.describe('draft scenery gallery', () => {
  test.skip(DIR === '', 'set P28_SCENERY_DIR to the directory the snapshots go to');

  for (const sentence of SENTENCES) {
    test(`${sentence.id} – ${sentence.text}`, async ({ page, request }) => {
      mkdirSync(DIR, { recursive: true });
      const response = await request.post('/api/play/games', { data: { sentence: sentence.text } });
      expect(response.status(), await response.text()).toBeLessThan(300);
      const { url } = (await response.json()) as { url: string };
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(url);
      await page.locator('canvas').first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: join(DIR, `${sentence.id}.png`) });
    });
  }
});
