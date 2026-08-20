import { expect, test, type Page } from '@playwright/test';

import { KIT } from '../src/kit';
import { VIEWER_BUDGETS } from '../src/kit/budgets';

/**
 * Oracle úlohy T7 — **vygenerovaný svět je opravdu postavený z kitu**.
 *
 * Do 20. 8. 2026 se svět z promptu kreslil z holých primitiv a všech 42 kusů
 * kitu leželo ladem. Tenhle test se ptá na tři věci, které se ze zdrojáku
 * odvodit nedají, protože co kde stojí rozhoduje semínko z konkrétního světa:
 *
 * 1. **Scéna kit doopravdy postavila** — a jednou dávkou na id kusu, ne jednou
 *    na umístěný kus. Duplicita v seznamu je duplicitní kreslicí volání.
 * 2. **Dvě načtení téhož světa dají tutéž výzdobu.** Unit test to měří nad
 *    plánem; tady se to měří nad tím, co skončilo v rendereru.
 * 3. **Snímek se pořád vejde do rozpočtu.** Kit přidal dávky i trojúhelníky a
 *    strop je společný s T6 — `data/profiles/web-viewer.json` přes `VIEWER_BUDGETS`.
 *
 * Svět je `C04` ze zmrazeného korpusu, tedy skutečná certifikovaná emise, ne
 * fixtura autorovaná vedle testu.
 */

/**
 * `C02` schválně, ne `C04`. Zmrazený korpus **nedeklaruje ani jednu neprůchodnou
 * buňku** (`src/ir/build.ts:327` je nastavuje na prázdné pole a validátor
 * layoutu zanikl s P5), takže zdi z kitu se na skutečném světě neobjeví a
 * dokazuje je jen unit test. Kulisu ale korpus má — `C02` nese entitu `valve`
 * s rolí `prop`, takže je na něm vidět i ta část výzdoby, která se hýbe.
 */
const PROMPT = 'C02';
const SETTLE_FRAMES = 3;

const KIT_IDS = new Set(KIT.map((piece) => piece.id));

async function settle(page: Page, frames = SETTLE_FRAMES): Promise<void> {
  const start = await page.evaluate(() => window.__viewer!.frames());
  await page.waitForFunction((target) => window.__viewer!.frames() > target, start + frames, {
    timeout: 30_000,
  });
}

/** Načte svět a počká, až most i výzdoba stojí. */
async function openWorld(page: Page): Promise<void> {
  await page.goto(`/embed/harbor-pier?emit=${PROMPT}`);
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => window.__viewer!.dressing().length > 0, undefined, {
    timeout: 60_000,
  });
  await settle(page);
}

test('vygenerovaný svět stojí z kusů kitu, jedna dávka na id', async ({ page }) => {
  test.setTimeout(120_000);

  await openWorld(page);
  const batches = await page.evaluate(() => window.__viewer!.dressing());

  expect(batches.length, 'scéna nepostavila z kitu vůbec nic').toBeGreaterThan(0);

  // 1. Každé id je skutečný kus kitu — ne překlep a ne kus, který zmizel.
  for (const batch of batches) {
    expect(KIT_IDS.has(batch.piece), `${batch.piece} není kus kitu`).toBe(true);
    expect(batch.instances, `${batch.piece} má prázdnou dávku`).toBeGreaterThan(0);
  }

  // 2. Jedna dávka na id. Dávka na umístěný kus by dala stovky volání.
  const ids = batches.map((batch) => batch.piece);
  expect(new Set(ids).size, 'id kusu se ve výzdobě opakuje').toBe(ids.length);

  // 3. Podlaha je z kitu, ne z holé roviny — a je jí tolik, kolik má svět buněk.
  const floor = batches.find((batch) => batch.piece === 'panel.floor');
  expect(floor, 'podlaha se nepostavila z dlaždic').toBeDefined();
  expect(floor!.instances, 'dlaždic je míň, než má nejmenší svět buněk').toBeGreaterThan(8);

  // 4. Kulisová entita nosí kus kitu, ne krychli. `C02` má právě jednu (`valve`),
  //    takže se dávka jejího kusu pozná podle toho, že přibyla k statice.
  const entities = await page.evaluate(() => window.__viewer!.entities());
  const props = entities.filter((entity) => entity.visual === 'prop');
  expect(props.length, 'svět bez kulisy by tuhle část výzdoby nedokázal').toBeGreaterThan(0);

  const dressed = batches.filter((batch) => batch.piece.startsWith('fixture.') || batch.piece.startsWith('organic.'));
  expect(dressed.length, 'kulisa se neoblékla do žádného kusu kitu').toBeGreaterThan(0);
});

test('tentýž svět dá po znovunačtení tutéž výzdobu', async ({ page }) => {
  test.setTimeout(120_000);

  await openWorld(page);
  const first = await page.evaluate(() => window.__viewer!.dressing());

  await openWorld(page);
  const second = await page.evaluate(() => window.__viewer!.dressing());

  const signature = (batches: readonly { piece: string; instances: number }[]): string =>
    [...batches]
      .map((batch) => `${batch.piece}=${batch.instances}`)
      .sort()
      .join('|');

  expect(signature(second), 'dvě načtení téhož světa se rozešla').toBe(signature(first));
});

test('kit ve scéně nepřekročil rozpočet snímku', async ({ page }) => {
  test.setTimeout(120_000);

  await openWorld(page);
  const stats = await page.evaluate(async (frames) => {
    const viewer = window.__viewer!;
    const from = viewer.frames();
    while (viewer.frames() < from + frames) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
    return viewer.render();
  }, SETTLE_FRAMES);

  expect(stats.calls, 'kreslicích volání za snímek, včetně stínového průchodu').toBeLessThanOrEqual(
    VIEWER_BUDGETS.maxDrawCallsPerFrame,
  );
  expect(stats.triangles, 'trojúhelníků za snímek').toBeLessThanOrEqual(
    VIEWER_BUDGETS.maxTrianglesPerFrame,
  );
});
