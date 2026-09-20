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

/**
 * Věta ze zmrazeného `evals/worldstream/create.jsonl` (`c04`), kterou astra@high
 * v P16 postavila nejrychleji – 122 s lokálně. Pomalejší věta by na Vercelu
 * Hobby narazila na strop funkce 300 s dřív, než by test cokoli řekl.
 */
const LIVE_PROMPT = 'A brutalist observatory, one dome on three splayed legs, on a windswept plateau.';

/**
 * Text napsaný do pole do ~3 s po načtení smaže hydratace. Vyplní se znovu,
 * dokud hodnota nevydrží dvě kontroly po sobě – táž past jako v
 * `e2e/effort-compare.spec.ts`.
 */
async function fillStable(page: Page, prompt: string): Promise<void> {
  const input = page.getByTestId('prompt-input');
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if ((await input.inputValue()) !== prompt) await input.fill(prompt);
    await page.waitForTimeout(1_000);
    if ((await input.inputValue()) !== prompt) continue;
    await page.waitForTimeout(1_000);
    if ((await input.inputValue()) === prompt) return;
  }
  throw new Error('the prompt input kept losing the sentence');
}

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

/**
 * Hlavní stránka, ne `/classic` – ta je vyřazená cesta a oracle má měřit
 * produkt (P15 `G1-classiclive`, P16 T8). **Připravený svět nestačí:**
 * `world-authored` přijde hned po odeslání a nic o modelu netvrdí, takže test,
 * který by prošel na něm, by tvrdil živý model, který neběží. Rozhoduje
 * `world-live-origin` („Live model generation").
 */
test('první věta na hlavní stránce postaví živý svět od modelu', async ({ page }) => {
  // Generování má na Vercelu strop funkce 300 s; test čeká chvíli nad ním.
  test.setTimeout(420_000);
  const errors = collectPageErrors(page);
  await page.goto('/');
  await expect(page.getByTestId('prompt-input')).toBeVisible({ timeout: 30_000 });
  await fillStable(page, LIVE_PROMPT);
  await page.getByTestId('prompt-submit').click();

  // Nedoručený svět od 15. 9. 2026 řekne proč (`second-act-missed`); test pak
  // skončí hned a s tím důvodem, ne až po 330 s mlčení (P16 `T8-silentlive`).
  const missed = page.locator('[data-testid="world-status"][data-state="broken"], [data-testid="visual-preview-notice"]');
  await expect(page.getByTestId('world-live-origin').or(missed)).toBeVisible({ timeout: 330_000 });
  expect((await missed.count()) === 0 ? '' : await missed.textContent(), 'živý svět nedorazil').toBe('');
  expect(errors, `stránka vyhodila chybu: ${errors.join(' | ')}`).toEqual([]);
});
