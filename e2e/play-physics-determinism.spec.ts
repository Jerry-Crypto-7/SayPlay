/**
 * Rapier dá v Chromiu tentýž hash jako v Node (P29A T11). Hodnota z Node je ve
 * fixtuře `src/play/arcade/physics/__fixtures__/determinism.json`, kterou hlídá
 * i vitest – když se rozejdou, fyzika by hráči ujela jinam než robotovi.
 *
 * Server musí běžet s `PLAY_LAB=1` (stránka laboratoře je jinak v produkci 404).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

const fixture = JSON.parse(readFileSync(join(__dirname, '../src/play/arcade/physics/__fixtures__/determinism.json'), 'utf8')) as { hash: string };

test('Chromium computes the Rapier scene hash Node pinned', async ({ page }) => {
  await page.goto('/play/lab/physics');
  const lab = page.getByTestId('physics-lab');
  await expect(lab).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(lab).toHaveAttribute('data-hash', fixture.hash);
  const initMs = Number(await lab.getAttribute('data-init-ms'));
  test.info().annotations.push({ type: 'rapier-init-ms', description: String(initMs) });
  console.log(`rapier init in Chromium: ${initMs} ms`);
});
