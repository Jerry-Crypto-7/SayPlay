import { expect, test, type Page } from '@playwright/test';

/**
 * Oracle úlohy T4 vlny 3 — **scéna kreslí mezipolohy, ne jen celá pole**.
 *
 * Jednotkový test umí dokázat, že `interpolateEntities` spočítá střed úsečky.
 * Neumí dokázat, že ho `WorldScene` vůbec zavolá — je to komponenta rendereru a
 * ta se z vitestu nerozběhne. Mutace „kresli dál rovnou ze stavu runtimu" tedy
 * nechá všech 16 jednotkových testů zelených a svět bude dál dvacetkrát za
 * sekundu skákat o celé pole. Tenhle soubor zavírá právě tu mezeru.
 *
 * Měří se přes `window.__viewer.drawn()` — co šlo naposledy do matic instancí —
 * proti `entities()`, což je přesný stav po tiku. Mezi dvěma tiky se ty dvě věci
 * musejí lišit, a to tak, že nakreslená poloha **nesedí na mřížce**.
 */

const PROMPT = 'C02';

/** Poloha je odvozená z celočíselné buňky, takže všechny tikové polohy sdílejí jeden zlomek. */
const ON_GRID_EPS = 1e-6;

interface Sample {
  readonly drawn: readonly (readonly [number, number])[];
  readonly ticks: readonly (readonly [number, number])[];
  readonly tickSpan: number;
}

async function openWorld(page: Page, prompt = PROMPT): Promise<void> {
  await page.goto(`/embed/harbor-pier?emit=${prompt}`);
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => window.__viewer!.dressing().length > 0, undefined, {
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__viewer!.assembly().done, undefined, { timeout: 60_000 });
}

/** Vezme vzorky po snímcích — po tikách by z definice žádnou mezipolohu netrefily. */
async function sampleFrames(page: Page, frames: number): Promise<Sample> {
  return page.evaluate(async (count) => {
    const avatarOf = (list: readonly { visual: string; position: { x: number; z: number } }[]) =>
      list.find((each) => each.visual === 'avatar');

    const drawn: [number, number][] = [];
    const ticks: [number, number][] = [];
    const firstTick = window.__viewer!.tick();

    for (let i = 0; i < count; i += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const painted = avatarOf(window.__viewer!.drawn());
      const exact = avatarOf(window.__viewer!.entities());
      if (painted !== undefined) drawn.push([painted.position.x, painted.position.z]);
      if (exact !== undefined) ticks.push([exact.position.x, exact.position.z]);
    }

    return { drawn, ticks, tickSpan: window.__viewer!.tick() - firstTick };
  }, frames);
}

function offsetOf(value: number): number {
  return value - Math.round(value);
}

function onGrid(value: number, offset: number): boolean {
  return Math.abs(value - offset - Math.round(value - offset)) < ON_GRID_EPS;
}

test('mezi dvěma tiky stojí postava jinde než na mřížce', async ({ page }) => {
  test.setTimeout(120_000);

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await openWorld(page);
  const { drawn, ticks, tickSpan } = await sampleFrames(page, 90);

  expect(ticks.length, 'svět nemá postavu, na které by se dal pohyb měřit').toBeGreaterThan(0);
  expect(tickSpan, 'během měření neuběhl ani jeden tik — test by netvrdil nic').toBeGreaterThan(1);

  const moved = new Set(ticks.map(([x, z]) => `${x},${z}`));
  expect(moved.size, 'postava se během měření nehnula z místa').toBeGreaterThan(1);

  // Zlomek mřížky se bere z naměřené tikové polohy, ne z počtu polí: sudá šířka
  // posadí buňky na půlky, lichá na celá čísla, a test nemá proč to vědět.
  const offX = offsetOf(ticks[0][0]);
  const offZ = offsetOf(ticks[0][1]);
  expect(
    ticks.every(([x, z]) => onGrid(x, offX) && onGrid(z, offZ)),
    'tiková poloha sama nesedí na mřížce — měří se něco jiného, než si test myslí',
  ).toBe(true);

  const between = drawn.filter(([x, z]) => !onGrid(x, offX) || !onGrid(z, offZ));

  expect(
    between.length,
    `ze ${drawn.length} nakreslených snímků neleží mezi poli ani jeden — scéna kreslí rovnou stav tiku a postava skáče`,
  ).toBeGreaterThan(0);

  // Druhá strana téhož: obraz smí být o tik pozadu, ne o půl světa. Kdyby se
  // starší poloha přestala posouvat, mezipolohy by mimo mřížku ležely dál a
  // zkouška výš by prošla, zatímco postava by se odplazila pryč od hry.
  const drift = drawn.map(([x, z], index) =>
    Math.hypot(x - ticks[index][0], z - ticks[index][1]),
  );
  const worst = Math.max(...drift);
  expect(
    worst,
    `nakreslená poloha se od stavu tiku vzdálila o ${worst.toFixed(2)} pole — víc než jeden tah, takže obraz nesleduje hru`,
  ).toBeLessThan(1.5);

  expect(errors, `stránka spadla: ${errors.join(' | ')}`).toEqual([]);
});

test('krokování bez nástěnného času kreslí přesný stav po tiku', async ({ page }) => {
  test.setTimeout(120_000);

  await openWorld(page);

  // `step(n)` je cesta, kterou měří celý offline řetěz. Kdyby po ní zůstala na
  // plátně mezipoloha, každý snímek z prohlížeče by ukazoval jiný svět, než
  // jaký se hashuje — a poznalo by se to až na rozcházejících se číslech.
  const after = await page.evaluate(() => {
    window.__viewer!.step(7);
    return {
      drawn: window.__viewer!.drawn().map((each) => [each.stableId, each.position.x, each.position.z]),
      exact: window.__viewer!.entities().map((each) => [each.stableId, each.position.x, each.position.z]),
    };
  });

  expect(after.drawn.length, 'plátno po krokování nekreslí nic').toBeGreaterThan(0);
  expect(after.drawn, 'po `step()` zůstala na plátně mezipoloha místo stavu po tiku').toEqual(
    after.exact,
  );
});
