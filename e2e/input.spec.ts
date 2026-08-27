import { expect, test, type Page } from '@playwright/test';

/**
 * Oracle úlohy T3 — **hru řídí hráč, ne scriptovaná stopa**.
 *
 * Do 19. 8. 2026 si hra hrála sama: `PlayView` krmil smyčku stopou od řešitele
 * archetypu a stisk klávesy nedělal nic. Tenhle test se ptá na to jediné, co ten
 * rozdíl odlišuje — jestli se svět hne, když se hne prst, a jestli se nehne, když
 * se hnout nemá.
 *
 * Svět je deterministický z promptu (`sessionFor` odvozuje n-tici i seed
 * hashem), takže výchozí buňka `[0, 0]` v aréně 7×7 je pokaždé stejná a test se
 * o ni smí opřít. Kraj arény je v této hře zeď: `a1Advance` odmítne cíl mimo
 * mřížku, takže stisk doleva z nultého sloupce je přesně ta „rána do zdi", na
 * kterou AC míří.
 *
 * Tři aserce, tři různé vady:
 *  - pohyb doprava o jedno pole → vstup se vůbec dostane do hry;
 *  - stisk do zdi bez změny → hra si vstup ověřuje, nekopíruje ho do stavu;
 *  - jeden stisk = jeden pohyb → záměry se čerpají po tiku, ne po snímku.
 */

/** Tik je 50 ms; dva tiky bezpečně pokryjí zařazení i vyčerpání jednoho záměru. */
const TICKS_TO_DRAIN = 2;

interface Snapshot {
  readonly cell: readonly [number, number] | null;
  readonly tick: number;
  readonly phase: string | null;
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => ({
    cell: window.__fallback!.avatar(),
    tick: window.__fallback!.tick(),
    phase: window.__fallback!.phase(),
  }));
}

/** Stiskne klávesu a počká, až ji smyčka vyčerpá. Bez čekání by se četl starý stav. */
async function press(page: Page, key: string, ticks = TICKS_TO_DRAIN): Promise<Snapshot> {
  const before = await snapshot(page);
  await page.keyboard.press(key);
  await page.waitForFunction(
    (target) => window.__fallback!.tick() >= target,
    before.tick + ticks,
    { timeout: 15_000 },
  );
  return snapshot(page);
}

test('hru řídí klávesnice, a hra si vstup ověřuje', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/fallback/play');
  await page.waitForFunction(() => window.__fallback !== undefined, undefined, { timeout: 60_000 });

  const start = await snapshot(page);
  expect(start.phase, 'partie musí běžet, jinak nemá co reagovat').toBe('running');
  expect(start.cell, 'tahle hra má postavu na mřížce').not.toBeNull();
  expect(start.cell![0], 'test je psaný na výchozí buňku u kraje arény').toBe(0);

  // 1. Stisk do zdi. Nultý sloupec nemá vlevo kam jít, takže se pozice nesmí hnout.
  const intoWall = await press(page, 'ArrowLeft');
  expect(intoWall.phase).toBe('running');
  expect(intoWall.cell, 'stisk do zdi posunul postavu ven z arény').toEqual(start.cell);
  expect(intoWall.tick, 'čas musí běžet i při zamítnutém pohybu').toBeGreaterThan(start.tick);

  // 2. Stisk doprava. Jedno pole v ose x, osa y beze změny.
  const moved = await press(page, 'ArrowRight');
  expect(moved.phase).toBe('running');
  expect(moved.cell![0], 'ArrowRight neposunul postavu o jedno pole doprava').toBe(start.cell![0] + 1);
  expect(moved.cell![1], 'pohyb doprava změnil i osu y').toBe(start.cell![1]);

  // 3. Jeden stisk = jeden pohyb. Deset tiků bez další klávesy nesmí postavou
  //    hnout — kdyby se záměr držel ve frontě nebo aplikoval každý snímek,
  //    postava by po jednom stisku ujela až ke zdi.
  await page.waitForFunction((target) => window.__fallback!.tick() >= target, moved.tick + 10, {
    timeout: 15_000,
  });
  const drifted = await snapshot(page);
  expect(drifted.cell, 'postava se hýbe i bez vstupu — záměr se čerpá víc než jednou').toEqual(
    moved.cell,
  );
  expect(await page.evaluate(() => window.__fallback!.queued())).toBe(0);
});
