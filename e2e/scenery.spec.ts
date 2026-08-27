import { expect, test, type Page } from '@playwright/test';

import { FAMILIES } from '../src/geom/families';
import { VIEWER_BUDGETS } from '../src/kit/budgets';

/**
 * Oracle úlohy T2 vlny 3 — **program geometrie doopravdy staví do produktu**.
 *
 * Do 26. 8. 2026 byl `src/geom/**` mrtvý kód: 994 řádků a čtyři výtvarné
 * rodiny, na které se odvolává přihláška, a v `src/` ani jeden volající. Tenhle
 * test se ptá běžícího rendereru, ne zdrojáku — kolik kulisa přidala a jestli
 * se snímek pořád vejde do rozpočtu.
 *
 * **Nemíří na `/embed/harbor-pier` bez parametru, i když tak zní zadání úlohy.**
 * Ta cesta ukazuje ručně skládaný layout z kitu (`Viewer.tsx` sáhne po
 * `WorldScene` až se světem), takže kulisa na ní nevznikne a měření by tvrdilo,
 * že se nic nezměnilo. `?emit=C02` je tatáž cesta se skutečnou certifikovanou
 * emisí ze zmrazeného korpusu — táž, kterou měří `e2e/dressing.spec.ts`.
 */

const PROMPT = 'C02';
const SETTLE_FRAMES = 3;

const FAMILY_IDS = FAMILIES.map((family) => family.id);

async function settle(page: Page, frames = SETTLE_FRAMES): Promise<void> {
  const start = await page.evaluate(() => window.__viewer!.frames());
  await page.waitForFunction((target) => window.__viewer!.frames() > target, start + frames, {
    timeout: 30_000,
  });
}

async function openWorld(page: Page): Promise<void> {
  await page.goto(`/embed/harbor-pier?emit=${PROMPT}`);
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => window.__viewer!.dressing().length > 0, undefined, {
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__viewer!.assembly().done, undefined, { timeout: 60_000 });
  await settle(page);
}

test('kulisa z výtvarné rodiny stojí ve scéně a vejde se do rozpočtu snímku', async ({ page }) => {
  test.setTimeout(120_000);

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await openWorld(page);

  const scenery = await page.evaluate(() => window.__viewer!.scenery());

  expect(FAMILY_IDS, `kulisa hlásí rodinu „${scenery.family}", kterou registr nezná`).toContain(
    scenery.family,
  );
  expect(scenery.triangles, 'kulisa nepřidala ani jeden trojúhelník — geom je pořád odpojený').toBeGreaterThan(
    0,
  );
  expect(scenery.drawCalls, 'kulisa se nekreslí vůbec').toBeGreaterThan(0);
  // Počty výš si kulisa hlásí sama při stavbě, takže je nezmění ani zapomenuté
  // zavěšení do scény. Bez téhle zkoušky projde i běh, kde geom nic nevykreslí.
  expect(
    scenery.attached,
    'kulisa se postavila, ale nikdo ji nezavěsil do scény — geom je odpojený a počty výš to nepoznají',
  ).toBe(true);

  // Rozpočet se měří na tom, co renderer za snímek doopravdy udělal, včetně
  // stínového průchodu — ze zdrojáku se to spočítat nedá.
  const stats = await page.evaluate(() => window.__viewer!.render());
  expect(
    stats.calls,
    `kreslicích volání na snímek: ${stats.calls}, z toho kulisa ${scenery.drawCalls}`,
  ).toBeLessThanOrEqual(VIEWER_BUDGETS.maxDrawCallsPerFrame);
  expect(
    stats.triangles,
    `trojúhelníků na snímek: ${stats.triangles}, z toho kulisa ${scenery.triangles}`,
  ).toBeLessThanOrEqual(VIEWER_BUDGETS.maxTrianglesPerFrame);
  expect(stats.lights, 'kulisa nesmí přidat světlo — rig je čtyři a je to změna návrhu').toBe(
    VIEWER_BUDGETS.maxLights,
  );

  expect(errors, `stránka spadla: ${errors.join(' | ')}`).toEqual([]);
});

test('týž svět dá tutéž rodinu i podruhé', async ({ page }) => {
  test.setTimeout(120_000);

  await openWorld(page);
  const first = await page.evaluate(() => window.__viewer!.scenery());

  await openWorld(page);
  const second = await page.evaluate(() => window.__viewer!.scenery());

  expect(second, 'kulisa se mezi dvěma načteními téhož světa změnila').toEqual(first);
});
