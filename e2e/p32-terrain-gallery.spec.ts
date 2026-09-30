import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import sharp from 'sharp';

/**
 * Galerie knihovny terénu (P32A T9): ostrůvky, podlaha arény a voda, každý
 * generátor pod rigem vzhledu ve čtyřech sadách – tráva, sníh a led, dlažba
 * hradu, písek. Snímky jdou do `evals/play/p32/terrain/`, posuzuje je oko
 * (ukázka B); test hlídá jen to, co oko přehlédne: chybu shaderu vody a prázdný obraz.
 *
 * Server musí běžet s `PLAY_LAB=1` (stránka laboratoře je jinak v produkci 404).
 */

const KITS = ['islands', 'arena', 'water'] as const;
const SETS = ['meadow', 'snow', 'castle', 'desert'] as const;
const OUT = join(process.cwd(), 'evals/play/p32/terrain');

/** Rozptyl jasu snímku: jednobarevné plátno (nic se nenakreslilo) má skoro 0. */
async function spread(png: Buffer): Promise<number> {
  const { data } = await sharp(png).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let squares = 0;
  for (const value of data) {
    sum += value;
    squares += value * value;
  }
  const mean = sum / data.length;
  return Math.sqrt(squares / data.length - mean * mean);
}

test.use({ viewport: { width: 1280, height: 800 } });

for (const kit of KITS) {
  for (const look of SETS) {
    test(`${kit} in ${look}`, async ({ page }) => {
      test.setTimeout(90_000);
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(`/play/lab/terrain?kit=${kit}&look=${look}`);
      const lab = page.getByTestId('terrain-lab');
      await expect(lab).toHaveAttribute('data-ready', '1', { timeout: 60_000 });
      // Kulisy arény jsou modely katalogu: fotit až po jejich načtení.
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
      mkdirSync(OUT, { recursive: true });
      const shot = await lab.locator('canvas').first().screenshot({ path: join(OUT, `${kit}-${look}.png`) });
      expect(await spread(shot), 'rozptyl jasu snímku').toBeGreaterThan(10);
      expect(errors.filter((text) => /THREE|shader|WebGL/i.test(text))).toEqual([]);
    });
  }
}
