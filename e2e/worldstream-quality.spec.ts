import { expect, test, type Page } from '@playwright/test';

import type { TransitionTiming } from '../src/app/dev/worldstream/page';
import type { StageProbe } from '../src/components/viewer/WorldstreamStage';
import { QUALITY_TIERS, budgetFor, type QualityTier } from '../src/worldstream/quality';

/**
 * **Adaptivní kvalita drží rozpočty** (P15 T26, design book §23).
 *
 * Tři úrovně nad jedním světem. Otázka je jediná: **utratí každá úroveň jen to,
 * co má rozpočtem dovolené** — a zůstane nejnižší z nich pořád plnohodnotný
 * svět, ne nouzový režim?
 *
 * ## Co tahle sada NEDOKAZUJE, a proč
 *
 * **Padesát snímků za vteřinu se tady certifikovat nedá.** AC úlohy mluví
 * o referenčním desktopu; tenhle běh používá renderer zvolený konfigurací
 * (`playwright.config.ts`), tedy nativní GPU nebo software. Samotná volba
 * rendereru nedokládá referenční podmínky. Sada proto fps **měří a vypíše**,
 * ale soudí jen to, co v tomhle prostředí smysl dává: že scéna po materializaci
 * dál kreslí. **Padesát fps zůstává neověřené** a stojí to tak i v plánu.
 *
 * **Hrdinský strop se tady taky neprojeví.** Ukázkový svět nese jediný napsaný
 * tvar (`tallHiveShape`), takže všechny tři úrovně vykreslí jednoho hrdinu a
 * strop 3 / 2 / 1 nemá do čeho kousnout. Ořezávání fan-outu podle úrovně proto
 * soudí jednotkový test nad blueprintem se třemi tvary
 * (`src/worldstream/__tests__/quality.test.ts`) — tam je to skutečná otázka,
 * tady by to byla zelená bez obsahu.
 *
 * ## Proč se úroveň vnucuje adresou
 *
 * Na jednom stroji se jinak vyzkouší právě jedna větev — ta, kterou pro něj
 * `chooseQualityTier()` vybere. `?tier=` je proto vlastnost harnessu, ne
 * obcházení: bez něj by dvě ze tří úrovní nikdy nikdo neviděl běžet.
 *
 * ## Proč se pixel ratio měří v druhém okně
 *
 * Headless Chromium hlásí `devicePixelRatio` 1, a rozpočet úrovně je **horní
 * mez**, ne příkaz — na takovém stroji kreslí všechny tři úrovně na 1 a stupínek
 * `dpr` nemá do čeho kousnout. Sada si proto pro něj otevře okno
 * s `deviceScaleFactor: 2`, kde se ty tři meze poprvé rozejdou, a měří to, co
 * ratio doopravdy platí: **plochu kreslicího bufferu**. Ta na ovladači nezávisí,
 * takže platí pro nativní i softwarový renderer; snímková frekvence na nich závisí.
 */

/** Kolik snímků se nechá proběhnout, než se čte. Účet `gl.info` platí až po nich. */
const SETTLE_FRAMES = 3;

/** Objekt s hrdinským tvarem — jediný, který se dá materializovat. */
const HERO = 'tallHive';

/** Jak dlouho se počítají snímky, když se měří tempo kreslení. */
const FPS_WINDOW_MS = 1_000;

declare global {
  interface Window {
    __worldstreamStage?: StageProbe;
  }
}

async function openStage(page: Page, tier?: QualityTier): Promise<void> {
  await page.goto(tier === undefined ? '/dev/worldstream' : `/dev/worldstream?tier=${tier}`);
  await expect(page.getByTestId('stage-status')).toContainText('slots at', { timeout: 60_000 });
  await page.waitForFunction(
    (frames) => (window.__worldstreamStage?.frames() ?? 0) > frames,
    SETTLE_FRAMES,
  );
}

async function quality(page: Page) {
  const probe = await page.evaluate(() => window.__worldstreamStage!.quality());
  expect(probe, 'svět se postavil, takže úroveň musí být známá').not.toBeNull();
  return probe!;
}

async function heroTriangles(page: Page): Promise<number> {
  return page.evaluate((id) => {
    const slot = window.__worldstreamStage!.slots().find((entry) => entry.stableId === id);
    return slot?.triangles ?? -1;
  }, HERO);
}

async function materialize(page: Page): Promise<void> {
  await page.getByTestId('materialize').click();
  await page.waitForFunction(() => window.__worldstreamStage!.commits() > 0, undefined, {
    timeout: 30_000,
  });
}

test.describe('worldstream adaptive quality', () => {
  // **Výchozích 30 s tady nestačí a není to vada produktu.** První
  // materializace po načtení stránky stojí na tomhle stroji 12–19 s a mezi
  // běhy skáče o řád (`evals/gates/geometry-budget.md`, `T39`). Test, který
  // materializuje a pak ještě vteřinu počítá snímky, se do 30 s vejde jen
  // někdy — a padal by na počasí, ne na rozpočtu.
  test.describe.configure({ timeout: 120_000 });

  for (const tier of QUALITY_TIERS) {
    test(`úroveň ${tier} staví svět uvnitř svých rozpočtů`, async ({ page }) => {
      await openStage(page, tier);
      const probe = await quality(page);

      // Úroveň, kterou scéna hlásí, musí být ta vnucená — jinak by zbytek testu
      // porovnával naměřené proti rozpočtu, který se toho světa netýká.
      expect(probe.tier).toBe(tier);
      expect(probe.budget).toEqual(budgetFor(tier));

      expect(probe.heroes).toBeLessThanOrEqual(probe.budget.heroes);
      expect(probe.drawCalls).toBeGreaterThan(0);
      expect(probe.drawCalls).toBeLessThanOrEqual(probe.budget.maxDrawCalls);
      expect(probe.triangles).toBeGreaterThan(0);
      expect(probe.triangles).toBeLessThanOrEqual(probe.budget.maxSceneTriangles);

      // **Texturový stupínek žebříku měří stínová mapa.** Naměřeno 3. 9. 2026:
      // scéna nese čtyři textury, materiály z nich žádnou obrázkovou, a ta
      // velká je stín — 2048 na osu, tedy přesně strop nejvyšší úrovně. Nižší
      // úrovně ho proto musí srazit, jinak by „texture LOD" byl stupínek, po
      // kterém se nedá sejít.
      expect(probe.textureAxis).toBeGreaterThan(0);
      expect(probe.textureAxis).toBeLessThanOrEqual(probe.budget.textureAxis);

      // Ratio je strop, ne příkaz — v tomhle okně je `devicePixelRatio` 1,
      // takže tady se soudí jen to, že se strop nepřekročil. Že se tři meze
      // doopravdy rozcházejí, měří blok s `deviceScaleFactor: 2` níž.
      expect(probe.pixelRatio).toBeLessThanOrEqual(probe.budget.pixelRatio);
      expect(probe.drawingBufferPixels).toBeGreaterThan(0);
    });
  }

  test('materializace zůstane uvnitř rozpočtu na jeden tvar', async ({ page }) => {
    await openStage(page, 'full');
    await materialize(page);

    const probe = await quality(page);
    expect(await heroTriangles(page)).toBeLessThanOrEqual(probe.budget.maxTrianglesPerHero);
    expect(probe.triangles).toBeLessThanOrEqual(probe.budget.maxSceneTriangles);
  });

  test('nejnižší úroveň mřížku nezvedá a přesto je plně funkční', async ({ page }) => {
    await openStage(page, 'safe');

    const before = await heroTriangles(page);
    expect(before).toBeGreaterThan(0);

    // Plně funkční znamená, že celý řetěz materializace projde i tady — brána,
    // odhalení, commit. Nouzový režim by se poznal právě tím, že se tahle cesta
    // na nejnižší úrovni vypne.
    await materialize(page);

    const after = await heroTriangles(page);
    const probe = await quality(page);

    // **Tohle je celý mřížkový stupínek §23.** `safe` stojí na své cílové
    // mřížce od prvního snímku, takže „vyšší detail" je tentýž mesh — počet
    // trojúhelníků se nesmí hnout. Kdyby vyskočil, utratila by nejnižší úroveň
    // 48³, tedy přesně to, co nemá.
    expect(after).toBe(before);
    expect(after).toBeLessThanOrEqual(probe.budget.maxTrianglesPerHero);
    expect(probe.drawCalls).toBeLessThanOrEqual(probe.budget.maxDrawCalls);

    // A svět je pořád na obrazovce a dá se na něj ukázat — bez toho by druhá
    // věta neměla na co mířit.
    expect(await page.evaluate((id) => window.__worldstreamStage!.screen(id), HERO)).not.toBeNull();
  });

  test('scéna po materializaci nepřestane kreslit', async ({ page }) => {
    await openStage(page, 'full');
    await materialize(page);

    const drawn = await page.evaluate(async (windowMs) => {
      const start = window.__worldstreamStage!.frames();
      await new Promise((resolve) => setTimeout(resolve, windowMs));
      return window.__worldstreamStage!.frames() - start;
    }, FPS_WINDOW_MS);

    // Naměřené tempo se vypisuje pro nakonfigurovaný renderer. Tento smoke
    // neověřuje referenční podmínky pro 50 fps; práh zůstává „kreslí dál“.
    console.log(`[T26] frames in ${FPS_WINDOW_MS} ms on configured renderer: ${drawn}`);
    expect(drawn).toBeGreaterThan(0);
  });

  test('přechod na vyšší detail se rozpadne na worker a na commit', async ({ page }) => {
    await openStage(page, 'full');
    await materialize(page);

    const timing = await page.evaluate(() => window.__worldstreamTransition!());
    expect(timing, 'materializace doběhla, takže rozpad musí být naměřený').not.toBeNull();

    // **Tohle je ta věc, kterou `T39` nemohla změřit zvenku.** Obě půlky musí
    // být kladné a obě dohromady musí dávat přechod — kdyby jedna z nich byla
    // nula, měřilo by se něco jiného než hranice mezi workerem a commitem.
    expect(timing!.workerMs).toBeGreaterThan(0);
    expect(timing!.commitMs).toBeGreaterThan(0);

    // Commit v sobě má předepsané odhalení, takže kratší než ta animace být
    // nemůže. Kdyby byl, znamenalo by to, že se hodiny zastavily dřív než
    // commit — a rozpad by lhal v obou půlkách naráz.
    expect(timing!.revealMs).not.toBeNull();
    expect(timing!.commitMs).toBeGreaterThanOrEqual(timing!.revealMs!);

    console.log(
      `[T26] transition split: worker ${Math.round(timing!.workerMs)} ms · commit ${Math.round(
        timing!.commitMs,
      )} ms (z toho odhalení ${String(timing!.revealMs)} ms)`,
    );
  });

  test('bez vnucené úrovně si ji stránka vybere sama podle rendereru', async ({ page }) => {
    await openStage(page);
    const probe = await quality(page);

    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info == null ? '' : String(gl!.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '');
    });

    // Softwarový rasterizér **musí** spadnout na dno. Když prohlížeč jméno
    // rendereru nevydá, rozhodovala paměť a jádra — a tvrdit z toho něco
    // o volbě by znamenalo hádat, jaký stroj sadu zrovna pustil.
    if (/swiftshader|llvmpipe|software/i.test(renderer)) expect(probe.tier).toBe('safe');
    else expect(QUALITY_TIERS).toContain(probe.tier);
  });
});

test.describe('pixel ratio jako první stupínek žebříku', () => {
  test.describe.configure({ timeout: 120_000 });

  // Displej s dvojnásobnou hustotou. Bez něj jsou všechny tři meze nedosažené
  // a stupínek by se dal smazat, aniž by kterýkoli test zčervenal.
  test.use({ deviceScaleFactor: 2 });

  test('každá úroveň kreslí na svém stropu a plocha snímku klesá s ním', async ({ page }) => {
    const measured: Record<string, { ratio: number; pixels: number }> = {};

    for (const tier of QUALITY_TIERS) {
      await openStage(page, tier);
      const probe = await quality(page);
      expect(probe.tier).toBe(tier);
      // Na displeji s ratiem 2 je strop dosažitelný u všech tří úrovní, takže
      // rovnost je tady tvrzení, ne shoda náhod.
      expect(probe.pixelRatio).toBe(probe.budget.pixelRatio);
      measured[tier] = { ratio: probe.pixelRatio, pixels: probe.drawingBufferPixels };
    }

    // **Cena ratia je kvadratická a tohle je jediné místo, kde se to naměří.**
    // Plocha kreslicího bufferu je počet fragmentů na snímek; poměr ploch musí
    // odpovídat druhé mocnině poměru ratií, jinak by ratio platilo něco jiného,
    // než co se za něj kupuje.
    const shrink = (from: QualityTier, to: QualityTier): number =>
      measured[to].pixels / measured[from].pixels;
    const expected = (from: QualityTier, to: QualityTier): number =>
      (measured[to].ratio / measured[from].ratio) ** 2;

    expect(shrink('full', 'balanced')).toBeCloseTo(expected('full', 'balanced'), 1);
    expect(shrink('balanced', 'safe')).toBeCloseTo(expected('balanced', 'safe'), 1);
    expect(measured.safe.pixels).toBeLessThan(measured.full.pixels);

    console.log(
      `[T26] drawing buffer per tier at deviceScaleFactor 2: ` +
        QUALITY_TIERS.map(
          (tier) =>
            `${tier} ${String(measured[tier].ratio)}× = ${String(measured[tier].pixels)} px`,
        ).join(' · '),
    );
  });

  test('nejnižší úroveň je i na hustém displeji pořád celý svět', async ({ page }) => {
    await openStage(page, 'safe');
    await materialize(page);

    const probe = await quality(page);
    expect(probe.pixelRatio).toBe(1);
    expect(probe.heroes).toBeGreaterThan(0);
    expect(await page.evaluate((id) => window.__worldstreamStage!.screen(id), HERO)).not.toBeNull();
  });
});

declare global {
  interface Window {
    __worldstreamTransition?: () => TransitionTiming | null;
  }
}
