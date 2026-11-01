/**
 * Skripty úrovní (P68 T13): tentýž kód a semínko dají v prohlížeči (projekty `chromium` a `webkit-desktop`) bajt po
 * bajtu tatáž data úrovně a totéž místo zastavení rozpočtem jako v Node. Hodnota z Node se počítá tady, týmž modulem
 * (`src/play/scripts/lab.ts`), který stránka spouští.
 *
 * Server musí běžet s `PLAY_LAB=1` (stránka laboratoře je jinak v produkci 404).
 */

import { expect, test } from '@playwright/test';

import { labOutput, runLab } from '../src/play/scripts/lab';
import { loadQuickJs } from '../src/play/scripts/sandbox';

test('level scripts: the browser builds the same level data as Node, byte for byte', async ({ page }) => {
  const node = labOutput(runLab(await loadQuickJs()));
  await page.goto('/play/lab/scripts');
  const lab = page.getByTestId('scripts-lab');
  await expect(lab).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
  const browser = await page.getByTestId('scripts-lab-output').textContent();
  expect(browser?.length).toBe(node.length);
  expect(browser).toBe(node);
});
