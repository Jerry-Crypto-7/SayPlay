import { expect, test } from '@playwright/test';

import smoke from '../ops/fallback-smoke.json';

/**
 * Smoke uzamčeného fallbacku (P2 T205a krok 5, T205b krok 2).
 *
 * **Jeden soubor, dva cíle.** Bez `FALLBACK_SMOKE_URL` jede proti lokálnímu
 * produkčnímu buildu jako každý jiný e2e; s ní proti artefaktu, který právě
 * postavil `scripts/build-from-tag.mjs`, a v T205b proti nasazené URL. To je
 * celý smysl: kdyby to byly dva testy, „prošel lokální build" a „prošel smoke
 * nasazeného commitu" by mohly být dvě pravdy o dvou různých artefaktech —
 * přesně ta dvojice, kterou vytklo kolo 1 review nad T205.
 *
 * Případy se **neopisují**, berou se z `ops/fallback-smoke.json`: tři archetypy
 * a jeden `NO_FIT`. Tentýž soubor čte důkaz izolace z T204, takže se nedá
 * změnit jeden seznam a druhý ne.
 */

/**
 * Hash stromu, který má artefakt hlásit. Nastavuje ho pipeline; bez něj se
 * kontroluje jen to, že endpoint odpovídá **něčím**, protože běžný `next build`
 * z pracovního stromu žádný strom zapečený nemá.
 */
const EXPECTED_TREE = process.env.FALLBACK_SMOKE_TREE ?? null;

for (const expected of smoke.cases) {
  test(`${expected.kind} → ${expected.who}: ${expected.prompt}`, async ({ page }) => {
    const response = await page.goto(`${smoke.route}?prompt=${encodeURIComponent(expected.prompt)}`);
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId('route-kind')).toHaveText(expected.kind);
    await expect(page.getByTestId('route-archetype')).toHaveText(expected.who);
    await expect(page.getByTestId('route-layout')).toHaveText(expected.layout);
    // Rozhodnutí bez důvodu je podle §13.4 prázdná obrazovka s jiným pozadím.
    await expect(page.getByTestId('route-reason')).not.toBeEmpty();
  });
}

test('artefakt hlásí strom, ze kterého vznikl', async ({ request }) => {
  const response = await request.get('/api/build-id');
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { tree?: string };

  if (EXPECTED_TREE === null) {
    // Bez pipeline se tvrdí jen to, co je pravda: endpoint existuje a odpovídá.
    expect(body.tree, '/api/build-id nevrací tree').toBeTruthy();
    return;
  }
  expect(body.tree, 'nasazený artefakt nese jiný strom, než jaký se stavěl').toBe(EXPECTED_TREE);
});
