import { expect, test } from '@playwright/test';

/**
 * Oracle úlohy T303 — **`renderer.info.memory` po padesáti přepnutích**.
 *
 * Jednorázový úklid projde i implementaci, která odloží geometrii a zapomene
 * na texturu; poznat to jde až na desítkách světů, tedy přesně ve chvíli, kdy
 * porotce zkouší šestý prompt. `dispose() byl zavolán` je proxy, tohle je
 * oracle — údaj, který vede sám renderer o tom, co doopravdy drží.
 *
 * Vedle toho tu jsou zbylé tři věci z AC, každá proti skutečnému artefaktu:
 * kanál s průběhem emise, routa embedu a náhledový obrázek.
 */

const LAYOUT = 'harbor-pier';

/** Počká, až plátno vykreslí další snímky — přepnutí musí projít až na GPU. */
async function settle(page: import('@playwright/test').Page, frames = 3): Promise<void> {
  const start = await page.evaluate(() => window.__viewer!.frames());
  await page.waitForFunction((target) => window.__viewer!.frames() > target, start + frames, {
    timeout: 30_000,
  });
}

test('padesát přepnutí světa nenechá renderer držet víc zdrojů', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto(`/embed/${LAYOUT}`);
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });

  const layouts = await page.evaluate(() => window.__viewer!.layouts.length);
  expect(layouts, 'na přepínání jsou potřeba aspoň dva světy').toBeGreaterThan(1);

  // Základna se bere až po prvním přepnutí, ne po startu: první svět se teprve
  // nahrává na GPU a jeho čísla by ještě rostla z jiného důvodu než z netěsnosti.
  await page.evaluate(() => window.__viewer!.switchTo(1));
  await settle(page);
  const baseline = await page.evaluate(() => window.__viewer!.memory());

  expect(baseline.geometries, 'scéna nedrží žádnou geometrii').toBeGreaterThan(0);
  // Bez živé textury by o jejich úklidu tenhle běh netvrdil nic — a zapomenutá
  // textura je právě ta vada, na kterou padesát přepnutí míří.
  expect(baseline.textures, 'scéna nedrží žádnou texturu').toBeGreaterThan(0);

  for (let switched = 2; switched <= 50; switched += 1) {
    await page.evaluate((index) => window.__viewer!.switchTo(index), switched % layouts);
    await settle(page, 2);
  }

  // Zpátky na tentýž svět jako základna — jinak by se srovnávaly dvě různě
  // velké scény a rozdíl by nic neznamenal.
  await page.evaluate((index) => window.__viewer!.switchTo(index), 1 % layouts);
  await settle(page);
  const after = await page.evaluate(() => window.__viewer!.memory());

  expect(after.geometries, `geometrie narostly z ${baseline.geometries} na ${after.geometries}`).toBe(
    baseline.geometries,
  );
  expect(after.textures, `textury narostly z ${baseline.textures} na ${after.textures}`).toBe(baseline.textures);
});

test('SSE kanál doručí průběh emise dřív než verdikt', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto(`/embed/${LAYOUT}?emit=C01`);

  const progress = page.getByTestId('viewer-progress');
  // Že rámce odcházejí **průběžně** a ne naráz na konci, hlídá test
  // `rámce odcházejí průběžně` v `src/app/api/emit/__tests__/stream.test.ts` —
  // počítá průchody smyčkou událostí, což je vlastnost, ne rychlost stroje.
  // Tady se ověřuje, co z toho dojde do skutečného prohlížeče.
  await expect(page.getByTestId('viewer-phase-requested')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('viewer-phase-witness')).toBeVisible({ timeout: 60_000 });

  const phases = await progress.locator('li').allTextContents();
  expect(phases[0]).toBe('requested');
  expect(phases).toContain('emitted');
  expect(phases).toContain('schema');
  // Pořadí je součást tvrzení: průběh, který dorazí přeházený, popisuje jiný
  // řetěz, než jaký endpoint doopravdy vykonává.
  expect(phases.indexOf('schema')).toBeGreaterThan(phases.indexOf('emitted'));
  expect(phases.indexOf('witness')).toBeGreaterThan(phases.indexOf('lowering'));
});

test('embed je celý výřez a nic z něj nevede ven', async ({ page }) => {
  await page.goto(`/embed/${LAYOUT}`);
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });

  await expect(page.getByTestId('embed-root')).toHaveAttribute('data-layout', LAYOUT);
  const box = await page.locator('canvas').boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);

  // Vložený rám nemá spouštět emisi jen tím, že se načte.
  await expect(page.getByTestId('viewer-progress')).toHaveCount(0);
});

test('neznámý svět v embedu je 404, ne cizí svět', async ({ page }) => {
  const response = await page.goto('/embed/takovy-svet-neni');
  expect(response?.status()).toBe(404);
});

test('náhledový obrázek je skutečné PNG a liší se podle světa', async ({ request }) => {
  const harbor = await request.get(`/api/og?layout=${LAYOUT}`);
  expect(harbor.status()).toBe(200);
  expect(harbor.headers()['content-type']).toBe('image/png');

  const bytes = await harbor.body();
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const frost = await request.get('/api/og?layout=frost-plateau');
  expect(Buffer.from(bytes).equals(await frost.body())).toBe(false);

  const missing = await request.get('/api/og?layout=neexistuje');
  expect(missing.status()).toBe(404);
});

test('stránka embedu nabízí náhled odkazu', async ({ page }) => {
  await page.goto(`/embed/${LAYOUT}`);
  // Bez `og:image` je ze sdíleného odkazu šedý obdélník — a odkaz je to, jak
  // se demo dostane k porotci.
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    new RegExp(`/api/og\\?layout=${LAYOUT}$`),
  );
});
