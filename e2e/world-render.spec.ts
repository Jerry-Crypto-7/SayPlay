import { expect, test, type Page } from '@playwright/test';

/**
 * Oracle úlohy T2 — **běžící simulace nakreslená do scény**.
 *
 * Do 19. 8. 2026 se stav světa do 3D nepromítal vůbec: plátno umělo vykreslit
 * ručně skládaný layout z kitu a hra běžela vedle něj. Tenhle test se ptá na to
 * jediné, co ten rozdíl odlišuje — jestli scéna zná polohu entit z **běhu**,
 * nebo si ji vymýšlí.
 *
 * Test je postavený tak, aby ho shodily obě laciné náhražky, a je to schválně
 * dvojice aserce, ne jedna:
 *
 * - **Konstantní pozice** projde tvrzením „něco se pohnulo", protože konstanta
 *   se od většiny socketů liší. Shodí ji ale druhá polovina: entita, kterou
 *   svět nikdy nepohne, musí zůstat přesně na svém socketu.
 * - **Pozice ze socketu v deklaraci** projde tvrzením „nehybné stojí, kde mají",
 *   a shodí ji první polovina: po dvaceti ticích musí být aspoň jedna entita
 *   jinde, než kde začala.
 *
 * Svět je `C04` ze zmrazeného korpusu — tedy skutečná certifikovaná emise, ne
 * fixtura autorovaná vedle testu. Korpus je zmrazený (AC T2b), takže se jeho
 * čísla nemají jak změnit pod rukama.
 */

const PROMPT = 'C04';

/** Kolik tiků musí svět odkrokovat, než se ptáme na pohyb. Číslo je z AC úlohy. */
const TICKS = 20;

interface Emitted {
  readonly outcome: string;
  readonly doc: {
    readonly sim: {
      readonly sockets: Record<string, readonly [number, number]>;
      readonly entities: Record<string, { readonly socket: string; readonly role: string }>;
    };
  };
}

/** Počká, až plátno vykreslí další snímky — scéna musí projít až na GPU. */
async function settle(page: Page, frames = 3): Promise<void> {
  const start = await page.evaluate(() => window.__viewer!.frames());
  await page.waitForFunction((target) => window.__viewer!.frames() > target, start + frames, {
    timeout: 30_000,
  });
}

test('scéna kreslí entity tam, kde je má běžící simulace', async ({ page, request }) => {
  test.setTimeout(120_000);

  // Očekávání se bere z **odpovědi endpointu**, ne z konstant v testu. Kdyby se
  // korpus někdy hnul, test se hne s ním a nebude tvrdit nic o starém světě.
  const response = await request.post('/api/emit', { data: { promptId: PROMPT } });
  expect(response.status(), `emit ${PROMPT} musí odpovědět 200`).toBe(200);
  const emitted = (await response.json()) as Emitted;
  expect(emitted.outcome, `${PROMPT} musí být certifikovaný, jinak se nemá co kreslit`).toBe('CERTIFIED');

  const declared = emitted.doc.sim.entities;
  const sockets = emitted.doc.sim.sockets;
  const expectedCount = Object.keys(declared).length;
  expect(expectedCount, 'svět bez entit by tenhle test neuměl nic dokázat').toBeGreaterThan(1);

  await page.goto(`/embed/harbor-pier?emit=${PROMPT}`);
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });

  // Svět dorazí až posledním rámcem kanálu, takže se čeká na entity, ne na most.
  await page.waitForFunction(
    (count) => window.__viewer!.entities().length === count,
    expectedCount,
    { timeout: 60_000 },
  );
  await settle(page);

  const entities = await page.evaluate(() => window.__viewer!.entities());

  // 1. Délka pole a identita — přesně tolik prvků, kolik dokument deklaruje.
  expect(entities).toHaveLength(expectedCount);
  expect([...entities].map((entity) => entity.stableId).sort()).toEqual(Object.keys(declared).sort());

  // 2. Každý prvek nese světové souřadnice, ne `undefined` a ne `NaN`.
  for (const entity of entities) {
    expect(Number.isFinite(entity.position.x), `${entity.stableId}.position.x`).toBe(true);
    expect(Number.isFinite(entity.position.y), `${entity.stableId}.position.y`).toBe(true);
    expect(Number.isFinite(entity.position.z), `${entity.stableId}.position.z`).toBe(true);
  }

  // 3. Různé buňky dávají různé pozice. Kdyby projekce vracela konstantu, tahle
  //    aserce padne dřív, než se vůbec dojde k pohybu.
  const cells = new Set([...entities].map((entity) => entity.cell.join(',')));
  const positions = new Set([...entities].map((entity) => `${entity.position.x},${entity.position.z}`));
  expect(positions.size, 'entity na různých buňkách musí mít různé pozice').toBe(cells.size);

  // Dvacet tiků deterministicky, bez čekání na nástěnný čas.
  await page.evaluate((ticks) => window.__viewer!.step(ticks), TICKS);
  await settle(page);

  expect(await page.evaluate(() => window.__viewer!.tick())).toBeGreaterThanOrEqual(TICKS);

  const after = await page.evaluate(() => window.__viewer!.entities());
  const cellOf = new Map([...after].map((entity) => [entity.stableId, entity.cell]));

  const moved: string[] = [];
  const stayed: string[] = [];
  for (const [stableId, decl] of Object.entries(declared)) {
    const socket = sockets[decl.socket];
    const cell = cellOf.get(stableId);
    expect(cell, `${stableId} chybí ve scéně`).toBeDefined();
    (cell![0] === socket[0] && cell![1] === socket[1] ? stayed : moved).push(stableId);
  }

  // 4. Aspoň jedna pohyblivá entita je jinde, než kde začala. Tohle shodí
  //    projekci, která kreslí socket z deklarace místo běhu.
  expect(moved.length, `po ${TICKS} ticích se nepohnula ani jedna entita`).toBeGreaterThan(0);

  // 5. A všechny ostatní stojí PŘESNĚ na svém socketu. Tohle shodí konstantní
  //    pozici — ta by je odsunula pryč všechny naráz.
  expect(stayed.length, 'nehybné entity zmizely ze svých socketů').toBeGreaterThan(0);
  expect(moved.length + stayed.length).toBe(expectedCount);
});
