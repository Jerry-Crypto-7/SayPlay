import { expect, test, type Page } from '@playwright/test';

/**
 * Oracle úlohy T5 — **věta dovnitř, svět ven**.
 *
 * Do 19. 8. 2026 se v aplikaci nedalo napsat nic: úvodní stránka byla rotující
 * krychle a svět šel vyvolat jenom adresou. Tenhle test se ptá na to jediné, co
 * ten rozdíl odlišuje — jestli uživatel napíše větu a dostane za ni hratelnou
 * scénu.
 *
 * Čtyři aserce, čtyři různé vady:
 *  - jde na `/api/generate` → produkt nesahá na měřicí cestu;
 *  - **na `/api/emit` nesáhne ani jednou** → kdyby ano, produkt by se vezl na
 *    zmrazeném korpusu a čísla v reportu by přestala platit o něm;
 *  - fáze průběhu jsou vidět → obrazovka není během čekání prázdná;
 *  - scéna nakonec drží aspoň jednu entitu → doopravdy se to vykreslilo.
 *
 * **Prompt je doslovný text ze zmrazeného korpusu, a musí být.** Offline větev
 * hledá `record.prompt === call.prompt`, tedy přesnou shodu; cokoli jiného je
 * poctivé `NO_SOURCE`. Použít vymyšlenou větu by neznamenalo „test je
 * realističtější", ale „test měří chybovou cestu a myslí si, že měří tu
 * úspěšnou".
 */

/** Doslovný text `C03` ze zmrazeného korpusu — svět s postavou, která chodí. */
const FROZEN_PROMPT = 'a stealth level where guards patrol and see me if I stand in the light';

/** Věta, kterou zmrazený korpus nezná. Musí skončit poctivou hláškou, ne pádem. */
const UNKNOWN_PROMPT = 'a world that the frozen corpus has never heard of';

/** Posbírá adresy, na které stránka sáhla. Aserce se ptá jich, ne dojmu. */
function recordRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => seen.push(request.url()));
  return seen;
}

test('napsaná věta vyrobí scénu, a jde přes /api/generate', async ({ page }) => {
  test.setTimeout(120_000);

  const requests = recordRequests(page);

  // Odpověď se schválně zdrží, aby šly fáze průběhu vůbec pozorovat. Zdržuje se
  // jen doručení — požadavek jde na server skutečný a odpověď je jeho vlastní.
  await page.route('**/api/generate', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await route.continue();
  });

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  // Úvodní obrazovka nic nepředstírá: dokud nepřišel prompt, žádné entity.
  expect(await page.evaluate(() => window.__worldsmith!.entities().length)).toBe(0);

  await page.getByTestId('prompt-input').fill(FROZEN_PROMPT);
  await page.getByTestId('prompt-submit').click();

  // 1. Fáze průběhu jsou vidět, dokud se čeká.
  await expect(page.getByTestId('prompt-progress')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('prompt-phase-odesláno')).toBeVisible();

  // 2. Scéna nakonec drží entity běžícího světa.
  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, {
    timeout: 60_000,
  });
  const entities = await page.evaluate(() => window.__worldsmith!.entities());
  expect(entities.length, 'svět bez entit není vykreslená scéna').toBeGreaterThan(0);
  for (const entity of entities) {
    expect(Number.isFinite(entity.position.x), `${entity.stableId}.position.x`).toBe(true);
    expect(Number.isFinite(entity.position.z), `${entity.stableId}.position.z`).toBe(true);
  }

  // 3. Nic nespadlo na nespustitelný svět a nevypsala se chyba.
  await expect(page.getByTestId('prompt-error')).toHaveCount(0);
  await expect(page.getByTestId('world-broken')).toHaveCount(0);

  // 4. Šlo to na produktovou cestu, a na měřicí ani jednou.
  expect(
    requests.filter((url) => url.includes('/api/generate')).length,
    'prompt se neodeslal na /api/generate',
  ).toBeGreaterThan(0);
  expect(
    requests.filter((url) => url.includes('/api/emit')),
    'produkt sáhl na měřicí cestu /api/emit',
  ).toEqual([]);
});

test('věta mimo korpus skončí hláškou, ne prázdnou obrazovkou', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  await page.getByTestId('prompt-input').fill(UNKNOWN_PROMPT);
  await page.getByTestId('prompt-submit').click();

  await expect(page.getByTestId('prompt-error')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('prompt-error')).toContainText('offline větev');
  // A plátno zůstalo, na čem bylo — odmítnutí není pád.
  expect(await page.evaluate(() => window.__worldsmith!.entities().length)).toBe(0);
});

test('prázdný vstup neodešle nic', async ({ page }) => {
  test.setTimeout(120_000);

  const requests = recordRequests(page);

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  await page.getByTestId('prompt-input').fill('   ');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('prompt-progress')).toHaveCount(0);

  expect(
    requests.filter((url) => url.includes('/api/generate')),
    'prázdný vstup se odeslal na server',
  ).toEqual([]);
});
