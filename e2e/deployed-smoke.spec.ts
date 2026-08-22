import { execFileSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';

/**
 * Oracle T26 — **nasazená adresa staví svět bez instalace.**
 *
 * Běží výhradně proti veřejné adrese, přes `playwright.deployed.ts`. Lokální
 * server si ta konfigurace schválně nestartuje: smoke test, který umí projít
 * proti `localhost`, netvrdí o nasazení nic.
 *
 * ## Proč se porovnává hash STROMU, ne commitu
 *
 * Zadání T26 psalo, že `/api/build-id` se rovná `git rev-parse HEAD`. **Naměřeno
 * 22. 8. 2026, že to platit nemůže:** routa vrací `{ tree }` a ta hodnota je
 * hash stromu (`git write-tree` nad rozbaleným archivem, viz
 * `scripts/build-from-tag.mjs`), kdežto `git rev-parse HEAD` je hash commitu.
 * Na tomtéž commitu vyšlo `4bbd92a9…` proti `6f649f96…` — dvě různé hodnoty
 * dvou různých věcí. Porovnává se proto `HEAD^{tree}`.
 *
 * `unbuilt` je hodnota z běžného `next build` nad pracovním stromem. Odmítá se
 * zvlášť a nahlas: kdyby se jen porovnávala s očekávaným hashem, hlásil by se
 * nesoulad hodnot místo skutečné příčiny, tedy že se nasadil artefakt mimo
 * pipeline.
 */

/** Očekávaný strom. Z prostředí, jinak ze stromu `HEAD` téhle pracovní kopie. */
function expectedTree(): string {
  const given = process.env.WORLDSMITH_EXPECTED_TREE;
  if (given !== undefined && given.length > 0) return given;
  return execFileSync('git', ['--no-replace-objects', 'rev-parse', 'HEAD^{tree}'], {
    encoding: 'utf-8',
  }).trim();
}

/** Věta ze zmrazeného korpusu. Shodná s `e2e/prompt-to-world.spec.ts`. */
const FROZEN_PROMPT = 'a stealth level where guards patrol and see me if I stand in the light';

/** Chyby stránky se sbírají od začátku — po `goto` už je pozdě. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('nasazená adresa odpoví na kořeni a nespadne', async ({ page }) => {
  const errors = collectPageErrors(page);

  const response = await page.goto('/');
  expect(response?.status(), 'kořen nevrátil 200').toBe(200);

  await expect(page.getByTestId('prompt-input')).toBeVisible({ timeout: 30_000 });
  expect(errors, `stránka vyhodila chybu: ${errors.join(' | ')}`).toEqual([]);
});

test('nasazený artefakt hlásí strom, ze kterého vznikl', async ({ request }) => {
  const response = await request.get('/api/build-id');
  expect(response.status()).toBe(200);

  const { tree } = (await response.json()) as { tree?: unknown };
  expect(
    tree,
    'nasadil se běžný `next build`, ne artefakt z `scripts/build-from-tag.mjs` — ' +
      'ten strom nemá jak znát',
  ).not.toBe('unbuilt');
  expect(tree).toBe(expectedTree());
});

test('první věta postaví svět', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  // Úvodní obrazovka nic nepředstírá: dokud nepřišla věta, žádné entity.
  expect(await page.evaluate(() => window.__worldsmith!.entities().length)).toBe(0);

  // Věta ze zmrazeného korpusu, tatáž jako v `prompt-to-world`. Věta mimo korpus
  // by se odroutovala na fallback a tenhle test by pak měřil jinou cestu, než
  // o které tvrdí, že ji měří.
  await page.getByTestId('prompt-input').fill(FROZEN_PROMPT);
  await page.getByTestId('prompt-submit').click();

  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, {
    timeout: 60_000,
  });

  expect(errors, `stránka vyhodila chybu: ${errors.join(' | ')}`).toEqual([]);
});
