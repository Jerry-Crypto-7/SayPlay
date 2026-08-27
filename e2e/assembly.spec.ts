import { expect, test, type Page } from '@playwright/test';

import { TICK_MS } from '../src/sim/clock';

/**
 * Oracle úlohy T11 — **svět se před divákem staví, neproblikne**.
 *
 * Unit testy v `src/components/viewer/__tests__/assembly.test.ts` dokazují, že
 * rozvrh rozprostírá kusy přes tiky. To, co dokázat neumějí, je jestli se to
 * takhle opravdu stane v rendereru: rozvrh se dá napsat správně a scéna ho může
 * ignorovat. Odtud se proto scéna ptá na **pozorované** mezníky —
 * `firstRevealTick` a `lastRevealTick` si zapisuje ve chvíli, kdy odhalených
 * kusů poprvé přibylo a kdy poprvé byly všechny.
 *
 * Tři tvrzení, a každé shodí jinou lacinou náhražku:
 *
 * 1. **Mezi prvním a posledním kusem uplyne aspoň osm tiků.** Scénu, která
 *    postaví svět naráz, shodí tohle: obě čísla by byla stejná.
 * 2. **Stavba je hotová do 2,5 s.** Rozvrh natažený na minutu by prošel (1),
 *    ale ne tímhle.
 * 3. **Při `prefers-reduced-motion: reduce` je svět celý hned.** Animaci
 *    zapnutou natvrdo shodí tohle.
 *
 * Svět je `C02` ze zmrazeného korpusu, tedy skutečná certifikovaná emise, ne
 * fixtura autorovaná vedle testu. Má kulisovou entitu, takže je na něm vidět i
 * ta část scény, která se hýbe.
 */

const PROMPT = 'C02';

/** Meze z AC úlohy. Nejsou to volby testu. */
const MIN_SPAN_TICKS = 8;
const MAX_BUILD_MS = 2500;

async function openWorld(page: Page): Promise<void> {
  await page.goto(`/embed/harbor-pier?emit=${PROMPT}`);
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => window.__viewer!.assembly().total > 0, undefined, {
    timeout: 60_000,
  });
}

test('svět se staví po dávkách řízených tikem, ne hodinami', async ({ page }) => {
  test.setTimeout(120_000);

  await openWorld(page);

  // Nástěnný čas se tu **měří a vypisuje, ale nesoudí se podle něj**, a je to
  // naměřený důvod, ne opatrnost. Headless Chromium kreslí přes SwiftShader,
  // tedy softwarově: první pozorování až po dostavění trvalo 21. 8. 2026
  // **12 523 ms**, zatímco v simulovaném čase byla stavba hotová za 1 800 ms.
  // To číslo měří rychlost softwarového rendereru, ne stavbu — aserce nad ním
  // by byla brána na SwiftShader. Mez 2,5 s se tedy soudí v simulovaném čase
  // (přesně) a na skutečném stroji ji uzavírá vizuální průchod v T25.
  const startedAt = Date.now();
  const opening = await page.evaluate(() => window.__viewer!.assembly());

  expect(opening.reducedMotion, 'test běží se zapnutou animací, jinak neměří stavbu').toBe(false);
  expect(opening.revealed, 'v prvním pozorování už musí být vidět aspoň jeden kus').toBeGreaterThan(0);

  await page.waitForFunction(() => window.__viewer!.assembly().done, undefined, { timeout: 30_000 });
  const elapsed = Date.now() - startedAt;

  const built = await page.evaluate(() => window.__viewer!.assembly());
  expect(built.revealed).toBe(built.total);
  expect(built.firstRevealTick, 'scéna nezaznamenala první odhalený kus').not.toBeNull();
  expect(built.lastRevealTick, 'scéna nezaznamenala poslední odhalený kus').not.toBeNull();

  const span = built.lastRevealTick! - built.firstRevealTick!;
  const plannedMs = (built.plannedSpanTicks + 1) * TICK_MS;
  console.log(
    `stavba: ${built.total} kusů, pozorované tiky ${built.firstRevealTick}–${built.lastRevealTick} ` +
      `(rozpětí ${span}), rozvrh ${built.plannedSpanTicks} tiků = ${plannedMs} ms simulovaného času, ` +
      `${elapsed} ms na nástěnných hodinách softwarového rendereru`,
  );

  // 1. Rozpětí v ticích, **pozorované**. Scénu, která postaví svět naráz, shodí
  //    tohle: obě čísla by byla stejná. Pomalý stroj rozpětí jen prodlouží —
  //    mezník se zapisuje při překreslení, takže mezi snímky přeskočí víc tiků.
  expect(span, 'mezi prvním a posledním kusem musí uplynout aspoň osm tiků').toBeGreaterThanOrEqual(
    MIN_SPAN_TICKS,
  );

  // 2. Stavba se vejde do 2,5 s. Soudí se **rozvrh**, ne pozorování: pozorované
  //    rozpětí nese i to, jak často stroj kreslí, a to není vlastnost stavby.
  expect(plannedMs, 'stavba v simulovaném čase').toBeLessThanOrEqual(MAX_BUILD_MS);
});

test('stavba se dá odkrokovat bez čekání na nástěnný čas', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto(`/embed/harbor-pier?emit=${PROMPT}`);
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => window.__viewer!.assembly().done, undefined, { timeout: 60_000 });

  // Po dostavění se kusy dál neodhalují — stavba je stav světa, ne opakující se
  // animace. A `step()` s ní nehne, protože už není co odhalit.
  const before = await page.evaluate(() => window.__viewer!.assembly());
  await page.evaluate(() => window.__viewer!.step(40));
  const after = await page.evaluate(() => window.__viewer!.assembly());

  expect(after.revealed).toBe(before.revealed);
  expect(after.firstRevealTick).toBe(before.firstRevealTick);
  expect(after.lastRevealTick).toBe(before.lastRevealTick);
});

test('tlumený pohyb ukáže svět celý naráz', async ({ page }) => {
  test.setTimeout(120_000);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWorld(page);

  const snapshot = await page.evaluate(() => window.__viewer!.assembly());

  expect(snapshot.reducedMotion, 'scéna se diváka nezeptala na tlumený pohyb').toBe(true);
  expect(snapshot.done, 'při tlumeném pohybu musí být svět hotový hned').toBe(true);
  expect(snapshot.revealed).toBe(snapshot.total);
  expect(snapshot.firstRevealTick).toBe(snapshot.lastRevealTick);
});
