import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Snímky obrazovek `/play` vedle referencí kitu Sayplay (P34). Nástroj pro oko,
 * ne test chování: snímky jdou do `evals/play/p34/<úloha>/` a úloha je
 * prohlédne vedle `docs/brand/reference-screens/*@2x.png`. Úloha je
 * `P34_SHOTS_TASK` (`T3`, `T4` … `final`), výběr stavů `P34_SHOTS_STATES`
 * (čárkami; prázdné = všechny). Každý další stav přidá úloha, která ho staví.
 *
 * Asertuje jen, že snímek vznikl, na stránce je jediná h1 a telefon se
 * neposouvá do strany.
 */

const TASK = process.env.P34_SHOTS_TASK || 'scratch';
const DIR = join(process.cwd(), 'evals', 'play', 'p34', TASK);
const ONLY = (process.env.P34_SHOTS_STATES ?? '').split(',').filter(Boolean);

const SIZES = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const;

async function home(page: Page): Promise<void> {
  await page.goto('/play');
  await expect(page.getByTestId('play-sentence')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const STATES: Record<string, (page: Page) => Promise<void>> = {
  home,
  // Karta nápadu vložila větu: počítadlo a bublina s textem.
  'home-idea': async (page) => {
    await home(page);
    await page.getByTestId('play-starter-chase_escape').click();
    await expect(page.getByTestId('play-sentence')).not.toHaveValue('');
    await page.waitForTimeout(400);
  },
};

test.describe.configure({ mode: 'serial' });

for (const [state, reach] of Object.entries(STATES)) {
  if (ONLY.length > 0 && !ONLY.includes(state)) continue;
  for (const size of SIZES) {
    test(`${state} ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await reach(page);
      await expect(page.locator('h1')).toHaveCount(1);
      if (size.width < 600) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
      mkdirSync(DIR, { recursive: true });
      await page.screenshot({ path: join(DIR, `${state}-${size.name}.png`) });
    });
  }
}
