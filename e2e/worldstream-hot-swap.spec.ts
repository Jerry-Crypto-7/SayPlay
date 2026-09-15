import { expect, test, type Page } from '@playwright/test';

import { MESH_DETAIL } from '../src/shape/types';
import type { StageProbe, StageSlotProbe } from '../src/components/viewer/WorldstreamStage';

/**
 * **Detail dorazí a neproblikne** (P15 T20, design book §13.3 a §14).
 *
 * Hrdina začne jako hlína ve 32³ a dostane mesh ve 48³. Sada se ptá na to
 * jediné, co se z kódu přečíst nedá: **proběhl ten přechod na scéně tak, jak
 * §13.3 předepisuje?**
 *
 * ## Proč se odhalení spouští tlačítkem
 *
 * Přechod trvá 700 ms. Kdyby se spouštěl sám, dal by se pozorovat jedině
 * závodem s vlastním pollingem — a taková sada je nespolehlivá z principu:
 * pomalý běh minutu okno propásne, rychlý ho stihne, a červená pak nic
 * neznamená. Harness proto materializaci spouští na povel a test ví, kdy okno
 * začalo.
 *
 * ## Co se soudí
 *
 * 1. **Scéna začne hrubým objektem.** Bez toho by se dalo „projít" tím, že se
 *    detail počká a hlína se nikdy nenakreslí — a slib „do tří sekund vidíš
 *    svět" by padl, aniž by kterýkoli test zčervenal.
 * 2. **Během odhalení stojí ve slotu obě podoby.** To je §13.3 body 4–6 a
 *    zároveň jediný rozdíl proti atomické výměně.
 * 3. **Po commitu zbude jedna** a identita se nehne: `stableId`, obal a
 *    **světové polohy socketů** jsou před i po tytéž.
 * 4. **Tlumený pohyb skončí týmž stavem.** Ne zkráceným odhalením — žádným.
 *
 * ⚠ **Dvě vědomé odchylky od AC v plánu, obě se zdůvodněním.**
 *
 * - AC mluví o meshi z **64³**. Produkt 64³ nepoužívá od 29. 8. 2026: žebřík je
 *   `MESH_DETAIL` = hrubá 32³, vysoká 48³, a `admitMesh()` soudí proti rozpočtu
 *   té příčky. Test proto měří **48³**, tedy to, co produkt doopravdy dělá;
 *   měřit 64³ by znamenalo certifikovat cestu, kterou nikdo nespustí.
 * - AC chce, aby se nezměnil **runtime hash**. Ten drží `WorldDocRuntime`, tedy
 *   stará herní cesta, která na `/dev/worldstream` neběží (rozhodnutí `T19b`).
 *   Ze čtveřice §13.2 se tu proto soudí `stableId`, obal a sockety; běžící
 *   entitu a její stav dostane hot-swap k soudu až s hlavní cestou (`T21b`).
 */

/** Kolik snímků se nechá proběhnout, než se čte. Světové matice platí až po prvním. */
const SETTLE_FRAMES = 3;

/** Objekt s hrdinským tvarem — jediný, který se dá materializovat. */
const HERO = 'tallHive';

declare global {
  interface Window {
    __worldstreamStage?: StageProbe;
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

/** Čeká, až se odhalení uzavře commitem. Nesoudí, jak dlouho to trvalo. */
async function waitForCommit(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__worldstreamStage!.commits() > 0, undefined, {
    timeout: 30_000,
  });
}

test.describe('worldstream hot-swap', () => {
  test('scéna začne hlínou a detail se objeví bez pop-inu', async ({ page }) => {
    await openStage(page);

    const before = await hero(page);
    // Hrubá podoba, žádný detail, žádné rozdělané odhalení.
    expect(before.rung).toBe('g3-reduced');
    expect(before.forms).toEqual({ total: 1, inGroup: 1 });
    expect(before.details).toEqual({ total: 0, inGroup: 0 });
    expect(before.staged).toBe(false);
    expect(before.contentHash).toBeNull();
    expect(await page.evaluate(() => window.__worldstreamStage!.reveal())).toBeNull();

    await page.getByTestId('materialize').click();

    // **Snímek se pořizuje uvnitř té iterace, ve které okno platí.** Odhalení
    // trvá 700 ms; kdyby se čekalo na `staged` a teprve pak se druhým voláním
    // četlo, mohl by mezi ta dvě volání spadnout commit — a sada by červenala
    // podle rychlosti stroje, ne podle chování produktu.
    const opened = await page.waitForFunction(
      () => window.__worldstreamStage!.slots().find((entry) => entry.staged) ?? null,
      undefined,
      { timeout: 30_000 },
    );
    const during = (await opened.jsonValue()) as StageSlotProbe;

    expect(during.stableId, 'odhalení se otevřelo na jiném slotu než hrdinovi').toBe(HERO);
    expect(during.failure).toBeNull();
    expect(during.details, 'kandidát není ve svém obalu právě jednou').toEqual({
      total: 1,
      inGroup: 1,
    });
    expect(during.forms, 'hrubá podoba během odhalení zmizela').toEqual({
      total: 1,
      inGroup: 1,
    });
    expect(during.attached, 'připojená podoba je pořád ta hrubá').toBe(true);
    expect(during.contentHash, 'hash se přepsal dřív, než odhalení doběhlo').toBeNull();

    await waitForCommit(page);

    const after = await hero(page);
    expect(after.staged).toBe(false);
    expect(after.details).toEqual({ total: 1, inGroup: 1 });
    expect(after.forms, 'hlína po commitu ze scény neodešla').toEqual({ total: 0, inGroup: 0 });
    expect(after.contentHash).not.toBeNull();
    expect(after.failure).toBeNull();

    // Bez tlumeného pohybu je odhalení plnohodnotné — protipól posledního testu.
    expect(await page.evaluate(() => window.__worldstreamStage!.lastReveal())).toMatchObject({
      stableId: HERO,
      reducedMotion: false,
    });
  });

  test('identita objektu výměnu přežije', async ({ page }) => {
    await openStage(page);
    const before = await hero(page);

    await page.getByTestId('materialize').click();
    await waitForCommit(page);

    const after = await hero(page);

    expect(after.stableId).toBe(before.stableId);
    expect(after.groups, 'obal se výměnou nezaložil znovu').toBe(1);
    expect(after.transform).toEqual(before.transform);
    expect(after.anchors).toEqual(before.anchors);

    // **Sockety jsou ta čtvrtá věc z §13.2 a čtou se ze scény.** Kdyby seděly
    // na meshi místo na obalu, výměna by s nimi hnula — a je to jediná z těch
    // čtyř vad, kterou by statický snímek nikdy neukázal.
    expect(after.sockets.map((socket) => socket.name)).toEqual(
      before.sockets.map((socket) => socket.name),
    );
    for (const socket of before.sockets) {
      const moved = after.sockets.find((candidate) => candidate.name === socket.name)!;
      for (let axis = 0; axis < 3; axis += 1) {
        expect(moved.at[axis], `socket ${socket.name} se hnul na ose ${axis}`).toBeCloseTo(
          socket.at[axis],
          5,
        );
      }
    }
  });

  test('detail je jemnější mřížka téhož tvaru, ne jiný objekt', async ({ page }) => {
    await openStage(page);
    const before = await hero(page);

    await page.getByTestId('materialize').click();
    await waitForCommit(page);

    const after = await hero(page);

    // Vyšší příčka žebříku znamená víc trojúhelníků. Kdyby jich bylo stejně,
    // připojil se tentýž mesh podruhé a „materializace" by byla ozdoba.
    expect(after.triangles).toBeGreaterThan(before.triangles);
    expect(after.triangles).toBeLessThanOrEqual(MESH_DETAIL.high.maxTriangles);
    // A pořád je to týž slot na témž místě.
    expect(after.rung).toBe(before.rung);
  });

  test('tlumený pohyb skončí týmž stavem, jen bez animace', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openStage(page);

    await page.getByTestId('materialize').click();

    // Tady se na okno **nečeká** a je to ten rozdíl, o který jde: při tlumeném
    // pohybu je odhalení hotové v prvním snímku, takže `reveal()` se dá
    // zastihnout, ale spolehnout se na to nedá. Rozvrh se proto čte z toho,
    // co si sonda pamatuje o commitu, ne z okna, které nemusí nastat.
    await waitForCommit(page);
    expect(await page.evaluate(() => window.__worldstreamStage!.reveal())).toBeNull();
    expect(await page.evaluate(() => window.__worldstreamStage!.lastReveal())).toEqual({
      stableId: HERO,
      reducedMotion: true,
      durationMs: 0,
    });

    const after = await hero(page);
    expect(after.details).toEqual({ total: 1, inGroup: 1 });
    expect(after.forms).toEqual({ total: 0, inGroup: 0 });
    expect(after.staged).toBe(false);
    expect(after.contentHash).not.toBeNull();
    expect(after.failure).toBeNull();
  });

  test('kamera se materializací nepohne', async ({ page }) => {
    await openStage(page);
    const before = await page.evaluate(() => window.__worldstreamStage!.camera());

    await page.getByTestId('materialize').click();
    await waitForCommit(page);

    const after = await page.evaluate(() => window.__worldstreamStage!.camera());
    expect(after).toEqual(before);
  });
});
