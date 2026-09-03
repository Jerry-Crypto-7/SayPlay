import { expect, test, type Page } from '@playwright/test';

import { SseDecoder } from '../src/components/viewer/sse';
import type { StageProbe, StageSlotProbe } from '../src/components/viewer/WorldstreamStage';
import type { ClientSnapshot } from '../src/worldstream/reducer';
import { applySnapshot, initialClientState, reduceEvent } from '../src/worldstream/reducer';
import type { SessionEvent } from '../src/worldstream/events';
import { deployedTarget } from './smoke-target';

/**
 * **Co zbude, když detail nedorazí** (P15 T21, design book §13.3 bod 7 a §27).
 *
 * `worldstream-hot-swap.spec.ts` soudí šťastnou cestu. Tenhle soubor soudí ty
 * ostatní, protože v jednom povedeném demu nejsou vidět vůbec: odmítnutý mesh,
 * dva výsledky na tentýž slot, reload uprostřed a pětadvacet výměn za sebou.
 * Pravidlo je u všech stejné — **selhání nesmí být horší než nepokus.**
 *
 * ## Oracle je renderer, ne účet registry
 *
 * `disposeSubtree()` umí vrátit poctivý účet a přitom nechat zdroj naživu,
 * když ho vedle registry drží ještě někdo jiný. Netěsnost se proto čte
 * z `renderer.info` — geometrie, textury a **programy**, protože zapomenutý
 * materiál odhalení se nikde jinde neprojeví.
 *
 * ⚠ **Tři vědomé odchylky od AC v plánu.**
 *
 * 1. **„zastaralý výsledek" se zkouší závodem, ne zvednutou revizí.** Revizi
 *    zvedá druhá věta (`T22`), takže dnes ji na této stránce nezvedne nic a
 *    testovat cestu, kterou nikdo nespustí, by znamenalo testovat harness.
 *    Reachable podoba téže vady je závod dvou výsledků: hrubší dorazí první,
 *    jemnější ho uprostřed odhalení vytlačí. Zvednutou revizi soudí jednotkově
 *    `representation-failure.test.ts`.
 * 2. **„reload po `world.ready` / `shape.ready`" se měří na scéně, ne na
 *    proudu.** Relaci na plátno teprve připojuje `T21b`; tady jsou to dva stavy
 *    téže stránky — svět postavený a podoba vyměněná. Klientskou půlku, tedy
 *    že se po ztrátě proudu nic nevymyslí, soudí poslední test přes skutečný
 *    server a skutečný reducer.
 * 3. **`session.failed` je legitimní konec.** Bez `.env` nemá server model,
 *    takže relace poctivě skončí — a to je maximum, které jde ověřit zadarmo.
 *    Poslední test proto soudí **tvar** obnovení, ne to, kam relace došla.
 */

/** Kolik snímků se nechá proběhnout, než se čte. Světové matice platí až po prvním. */
const SETTLE_FRAMES = 3;

/** Objekt s hrdinským tvarem — jediný, který se dá materializovat. */
const HERO = 'tallHive';

/** Kolik výměn se odjede na plató. Tolik jich AC úlohy žádá. */
const SWAPS = 25;

declare global {
  interface Window {
    __worldstreamStage?: StageProbe;
    /** Nejvyšší počet uzlů detailu, jaký kdy sonda mezi snímky viděla. */
    __detailPeak?: { max: number };
  }
}

async function openStage(page: Page): Promise<void> {
  await page.goto('/dev/worldstream');
  await expect(page.getByTestId('stage-status')).toContainText('slots at', { timeout: 60_000 });
  await page.waitForFunction(
    (frames) => (window.__worldstreamStage?.frames() ?? 0) > frames,
    SETTLE_FRAMES,
  );
}

async function hero(page: Page): Promise<StageSlotProbe> {
  const slots = await page.evaluate(() => window.__worldstreamStage!.slots());
  return slots.find((slot) => slot.stableId === HERO)!;
}

async function memory(
  page: Page,
): Promise<{ geometries: number; textures: number; programs: number }> {
  return page.evaluate(() => window.__worldstreamStage!.memory());
}

/**
 * Nechá plátno vykreslit `count` snímků.
 *
 * Snímky, ne hodiny: rozpočet v milisekundách projde i na stroji, kde plátno
 * zrovna nekreslí, a „nic se neobjevilo" by pak znamenalo „nic se nestihlo".
 */
async function settleFrames(page: Page, count: number): Promise<void> {
  const from = await page.evaluate(() => window.__worldstreamStage!.frames());
  await page.waitForFunction(
    (target) => window.__worldstreamStage!.frames() > target,
    from + count,
    { timeout: 60_000 },
  );
}

/** Čeká, až počet uzavřených odhalení překročí dané číslo. */
async function waitForCommits(page: Page, above: number): Promise<void> {
  await page.waitForFunction(
    (seen) => window.__worldstreamStage!.commits() > seen,
    above,
    { timeout: 60_000 },
  );
}

/**
 * Sleduje **každý snímek**, kolik uzlů detailu scéna drží.
 *
 * Bez toho se „ani krátce nebliklo" dokázat nedá: dvě čtení kolem kliknutí
 * říkají jen to, že na začátku a na konci nic nebylo. Sonda se čte znovu při
 * každém tiku, protože stage ji při každé přestavbě nahradí novým objektem.
 */
async function watchDetails(page: Page): Promise<void> {
  await page.evaluate((stableId) => {
    const peak = { max: 0 };
    window.__detailPeak = peak;
    const tick = (): void => {
      const slot = window.__worldstreamStage?.slots().find((entry) => entry.stableId === stableId);
      peak.max = Math.max(peak.max, slot?.details.total ?? 0);
      requestAnimationFrame(tick);
    };
    tick();
  }, HERO);
}

test.describe('worldstream odolnost', () => {
  test.describe.configure({ timeout: 180_000 });

  test('odmítnutý mesh nesmí ani krátce bliknout na plátně', async ({ page }) => {
    await openStage(page);
    await watchDetails(page);

    await page.getByTestId('materialize-overrun').click();
    await page.waitForFunction(
      (stableId) =>
        (window.__worldstreamStage!.slots().find((slot) => slot.stableId === stableId)?.failure ??
          null) !== null,
      HERO,
      { timeout: 30_000 },
    );

    // Ani jeden snímek s cizím tvarem — to je celá tahle úloha.
    expect(await page.evaluate(() => window.__detailPeak!.max)).toBe(0);

    const after = await hero(page);
    expect(after.failure, 'brána odmítla jinou vadou, než jakou harness poslal').toBe(
      'BOUNDS_OVERRUN',
    );
    // Svět zůstal přesně takový, jaký byl před pokusem.
    expect(after.forms).toEqual({ total: 1, inGroup: 1 });
    expect(after.details).toEqual({ total: 0, inGroup: 0 });
    expect(after.attached).toBe(true);
    expect(after.staged).toBe(false);
    expect(after.contentHash).toBeNull();
    expect(after.triangles, 'hlína přestala kreslit').toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__worldstreamStage!.commits())).toBe(0);
  });

  test('zastaralý výsledek prohraje a nezůstane po něm nic', async ({ page }) => {
    await openStage(page);
    const before = await memory(page);

    await page.getByTestId('materialize-race').click();
    await waitForCommits(page, 0);
    // Druhý snímek po commitu: uvolnění poražené podoby proběhne v tomtéž
    // volání, ale renderer své počty přepočítá až při dalším kreslení.
    await page.waitForFunction(
      (frames) => window.__worldstreamStage!.frames() > frames,
      await page.evaluate(() => window.__worldstreamStage!.frames() + 2),
    );

    const after = await hero(page);
    expect(after.details, 'poražený kandidát zůstal viset ve scéně').toEqual({
      total: 1,
      inGroup: 1,
    });
    expect(after.forms, 'hlína po výměně ze scény neodešla').toEqual({ total: 0, inGroup: 0 });
    expect(after.staged).toBe(false);
    expect(after.failure).toBeNull();
    expect(after.contentHash).not.toBeNull();
    // Jediné odhalení se uzavřelo jediným commitem — poražený svůj nedostal.
    expect(await page.evaluate(() => window.__worldstreamStage!.commits())).toBe(1);

    // Výměna je jedna za jednu: hlína odešla, detail přišel. Poražený kandidát
    // by tenhle součet zvedl, protože se stihl vykreslit.
    const held = await memory(page);
    expect(held.geometries, `geometrie ${before.geometries} → ${held.geometries}`).toBe(
      before.geometries,
    );
  });

  test('reload po postaveném světě postaví tentýž svět, ne jeho zbytek', async ({ page }) => {
    await openStage(page);
    const before = await page.evaluate(() => window.__worldstreamStage!.slots());

    await page.reload();
    await openStage(page);
    const after = await page.evaluate(() => window.__worldstreamStage!.slots());

    expect(after.length, 'po reloadu se postavil jiný počet slotů').toBe(before.length);
    // Identita §13.2 je tvrzení o slotu, ne o obrázku: `stableId`, obal a
    // sockety musí po reloadu sedět na milimetr, jinak nemá druhá věta na co
    // ukázat.
    expect(after.map((slot) => ({ ...slot, failure: null }))).toEqual(
      before.map((slot) => ({ ...slot, failure: null })),
    );
    for (const slot of after) {
      expect(slot.groups, `slot ${slot.stableId} se po reloadu nakreslil vícekrát`).toBe(1);
      expect(slot.details).toEqual({ total: 0, inGroup: 0 });
    }
  });

  test('reload po vyměněné podobě začne zase hlínou', async ({ page }) => {
    await openStage(page);
    await page.getByTestId('materialize').click();
    await waitForCommits(page, 0);
    expect((await hero(page)).contentHash).not.toBeNull();

    await page.reload();
    await openStage(page);

    // **Sto dvacet snímků, ne jedno čtení.** Přečíst stav hned po reloadu
    // dokazuje jen „ještě ne"; stránka, která by se materializovala sama —
    // třeba dobře míněným efektem na `world` — by tou zkouškou prošla a
    // porotci by se svět proměnil pod rukama. Naměřeno mutací 3. 9. 2026:
    // právě takový mutant tenhle test přežil, dokud se nečekalo.
    await watchDetails(page);
    await settleFrames(page, 120);
    expect(
      await page.evaluate(() => window.__detailPeak!.max),
      'po reloadu se detail objevil sám, bez kliknutí',
    ).toBe(0);

    const after = await hero(page);
    // Detail není stav světa: neuložil se, takže po reloadu je zase hlína a
    // porotce ji vidí ve stejném stavu jako první návštěvník.
    expect(after.rung).toBe('g3-reduced');
    expect(after.contentHash).toBeNull();
    expect(after.forms).toEqual({ total: 1, inGroup: 1 });
    expect(after.details).toEqual({ total: 0, inGroup: 0 });
    expect(after.failure).toBeNull();
    expect(await page.evaluate(() => window.__worldstreamStage!.commits())).toBe(0);
  });

  test('pětadvacet výměn nenechá renderer držet víc zdrojů', async ({ page }) => {
    // Tlumený pohyb dělá z každého odhalení jeden snímek místo 700 ms.
    // `T20` dokázal, že končí **týmž** stavem scény, takže se tím měří tatáž
    // výměna — jen se jich do rozpočtu sady vejde pětadvacet.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openStage(page);

    // Základna se bere až po **první** výměně, ne po startu: první detail se
    // teprve nahrává na GPU a jeho čísla by rostla z jiného důvodu než z netěsnosti.
    await page.getByTestId('materialize').click();
    await waitForCommits(page, 0);
    const baseline = await memory(page);
    expect(baseline.geometries, 'scéna nedrží žádnou geometrii').toBeGreaterThan(0);
    expect(baseline.programs, 'renderer si nevede programy, takže o materiálech nic neřekne').toBeGreaterThan(0);

    for (let swap = 2; swap <= SWAPS; swap += 1) {
      await page.getByTestId('materialize').click();
      await waitForCommits(page, swap - 1);
    }

    const after = await memory(page);
    expect(after.geometries, `geometrie ${baseline.geometries} → ${after.geometries}`).toBe(
      baseline.geometries,
    );
    expect(after.textures, `textury ${baseline.textures} → ${after.textures}`).toBe(
      baseline.textures,
    );
    // Materiál odhalení se v geometriích ani texturách neprojeví. Tady ano.
    expect(after.programs, `programy ${baseline.programs} → ${after.programs}`).toBe(
      baseline.programs,
    );

    const slot = await hero(page);
    expect(slot.details, 'po pětadvaceti výměnách drží slot víc než jednu podobu').toEqual({
      total: 1,
      inGroup: 1,
    });
    expect(slot.staged).toBe(false);
  });

  /* ---------------------------------------------------------------- *
   * Klientská půlka: ztráta proudu a obnovení ze snapshotu.
   * ---------------------------------------------------------------- */

  /**
   * ⛔ **Proti nasazené adrese běžet nesmí** — zakládá skutečnou relaci, takže
   * na nasazení s klíčem by jeden běh koupil generaci z živého stropu
   * utrácení. Lokálně je to zadarmo: `cloudEmitter()` bez `.env` vrátí `null`.
   * Tentýž důvod a tentýž zámek jako v `worldstream-session.spec.ts`.
   */
  test('ztráta proudu a obnovení ze snapshotu nevymyslí stav', async ({ page }) => {
    test.skip(
      deployedTarget() !== undefined,
      'zakládá skutečnou relaci, takže proti nasazené adrese by utrácel',
    );
    await page.goto('/api/build-id');

    const opened = await page.evaluate(async () => {
      const response = await fetch('/api/worldstream/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a switchback path up a scree slope in thin cold air' }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, string> };
    });
    expect(opened.status).toBe(202);

    // Krátký rozpočet = proud utržený uprostřed, tedy spadlé spojení.
    const first = await readStream(page, opened.body.events, 1_500);
    expect(first.length, 'z prázdného proudu se obnovovat nedá').toBeGreaterThan(0);

    let live = initialClientState();
    for (const event of first) {
      const step = reduceEvent(live, event);
      expect(step.ok, `rámec ${event.sequence} zabil proud, který server vydal celý`).toBe(true);
      if (step.ok) live = step.state;
    }

    // Reload klienta: stav v paměti je pryč a zbývá jediné, co přežije —
    // autoritativní snapshot.
    const snapshot = await readJson<ClientSnapshot>(page, opened.body.snapshot);
    const revived = applySnapshot(initialClientState(), snapshot);

    expect(revived.sessionId).toBe(opened.body.sessionId);
    expect(revived.phase).toBe(live.phase);
    expect(revived.sequence).toBeGreaterThanOrEqual(live.sequence);
    expect(
      revived.shapes.map((shape) => shape.stableId),
      'obnovený klient si vymyslel objekt, o kterém server neví',
    ).toEqual(snapshot.representations.map((entry) => entry.stableId));

    // A navázání za snapshotem nesmí najít mezeru ani zopakovat přechod.
    const resumed = await readStream(page, `${opened.body.events}?since=${revived.sequence}`, 3_000);
    expect(resumed.filter((event) => event.sequence <= revived.sequence)).toEqual([]);

    let after = revived;
    for (const event of resumed) {
      const step = reduceEvent(after, event);
      expect(step.ok, `obnovený proud hlásí ${step.ok ? '' : step.fault}`).toBe(true);
      if (step.ok) after = step.state;
    }
    expect(after.sessionId).toBe(opened.body.sessionId);
    expect(after.sequence).toBeGreaterThanOrEqual(revived.sequence);
  });
});

/* ------------------------------------------------------------------ *
 * Čtení proudu a snapshotu z prohlížeče. Stejná mechanika jako
 * `worldstream-session.spec.ts`: relativní `fetch` potřebuje stejný původ.
 * ------------------------------------------------------------------ */

async function readStream(page: Page, path: string, budgetMs: number): Promise<SessionEvent[]> {
  const read = await page.evaluate(
    async ({ url, budget }) => {
      const response = await fetch(url);
      if (response.body === null || !response.ok) return { ok: false, raw: '' };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + budget;
      let raw = '';

      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
        ]);
        if (chunk === null || chunk.done) break;
        raw += decoder.decode(chunk.value, { stream: true });
      }
      await reader.cancel().catch(() => undefined);
      return { ok: true, raw };
    },
    { url: path, budget: budgetMs },
  );

  if (!read.ok) return [];
  return new SseDecoder().push(read.raw).map((frame) => JSON.parse(frame.data) as SessionEvent);
}

async function readJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (url) => {
    const response = await fetch(url);
    return (await response.json()) as T;
  }, path);
}
