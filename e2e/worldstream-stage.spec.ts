import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import { toWorld } from '../src/worldstream/slots';
import type { StageProbe, StageSlotProbe } from '../src/components/viewer/WorldstreamStage';

/**
 * **Most z hrubého světa na plátno (P15 T19b).** První místo, kde se worldstream
 * vůbec kreslí — a proto jediná sada, která o něm může něco tvrdit.
 *
 * ## Proč to nejde jednotkovým testem
 *
 * Všechny tři vrstvy pod tímhle mostem už zelené jsou: `buildProxyWorld()` má
 * šest pinů na sloty, `RepresentationRegistry` osmnáct na výměnu podoby,
 * `mesh-gate` dvacet sedm na bránu. Vada, kterou tenhle soubor hlídá, je
 * přesně ta, kterou žádná z nich nechytí: **vrstvy jsou hotové a nikdo je
 * nevolá.** Do 3. 9. 2026 to tak doopravdy bylo — `RepresentationSlot.tsx`
 * neměl v produktu jediného importéra. Otázka „je to na plátně?" se dá položit
 * jedině plátnu.
 *
 * ## Čtyři věci, které se tu soudí
 *
 * 1. **Každý slot právě jednou.** Nejen „aspoň jednou": obal připojený dvakrát
 *    vypadá na statickém snímku identicky a rozejde se až při prvním
 *    hot-swapu, kdy se vymění jeden z těch dvou.
 * 2. **Podoba visí uvnitř svého obalu.** Uzel `form:<id>` vedle slotu místo pod
 *    ním znamená, že ho tam někdo pověsil mimo registry — a takový uzel
 *    nepřežije výměnu, protože registry o něm neví.
 * 3. **Sockety sedí tam, kam je slot poslal.** Očekávanou polohu si počítá
 *    tenhle soubor z `transform` a `anchors` přes `toWorld()`; scéna hlásí, kde
 *    ten uzel doopravdy je (`getWorldPosition`). Kdyby obě strany počítala
 *    stránka, porovnával by se výpočet sám se sebou.
 * 4. **Kulisa se kreslí vedle slotů, ne přes ně.** Jeden uzel kulisy, žádná
 *    podoba slotu uvnitř něj.
 *
 * ## Slepá ulička, která se tu zamyká
 *
 * `WorldScene.tsx` je stará herní cesta (`WorldDocRuntime`, `buildScene()`,
 * tikající runtime). Vestavět do ní sloty by slepilo dva produkty do jedné
 * komponenty; poslední test proto lexikálně hlídá, že se to nestalo.
 */

/** Kolik snímků se nechá proběhnout, než se čte. Světové matice platí až po prvním. */
const SETTLE_FRAMES = 3;

/** Objekty ručního blueprintu a příčka, na kterou každý z nich musí sednout. */
const EXPECTED_RUNGS: Readonly<Record<string, string>> = {
  hillsideTerrace: 'g2-rich',
  drystoneWall: 'g2-rich',
  tallHive: 'g3-reduced',
  smokerBox: 'g2-rich',
};

declare global {
  interface Window {
    __worldstreamStage?: StageProbe;
  }
}

async function openStage(page: Page): Promise<readonly StageSlotProbe[]> {
  await page.goto('/dev/worldstream');
  await expect(page.getByTestId('stage-status')).toContainText('slots at', { timeout: 60_000 });
  await page.waitForFunction(
    (frames) => (window.__worldstreamStage?.frames() ?? 0) > frames,
    SETTLE_FRAMES,
  );
  return page.evaluate(() => window.__worldstreamStage!.slots());
}

test.describe('worldstream stage', () => {
  test('hrubý svět postaví každý slot na plátně právě jednou', async ({ page }) => {
    const slots = await openStage(page);

    expect(slots.map((slot) => slot.stableId)).toEqual(Object.keys(EXPECTED_RUNGS));

    for (const slot of slots) {
      // Příčka se soudí spolu s počtem: slot, který spadl na hlínu, by prošel
      // testem „je tam právě jednou" a přitom by znamenal, že se most kreslí,
      // ale kompozice do něj nedošla.
      expect(slot.rung, `${slot.stableId} spadl na jinou příčku`).toBe(
        EXPECTED_RUNGS[slot.stableId],
      );
      expect(slot.groups, `obal ${slot.stableId} není na scéně právě jednou`).toBe(1);
      expect(slot.attached, `${slot.stableId} nemá připojenou podobu`).toBe(true);
      expect(slot.triangles, `${slot.stableId} nekreslí ani trojúhelník`).toBeGreaterThan(0);
    }
  });

  test('podoba visí uvnitř svého obalu, ne vedle něj', async ({ page }) => {
    const slots = await openStage(page);

    for (const slot of slots) {
      expect(slot.forms.total, `podoba ${slot.stableId} je na scéně vícekrát`).toBe(1);
      expect(slot.forms.inGroup, `podoba ${slot.stableId} visí mimo svůj obal`).toBe(1);
    }
  });

  test('sockety leží tam, kam je poslala transformace slotu', async ({ page }) => {
    const slots = await openStage(page);

    for (const slot of slots) {
      // Prázdné kotvy jsou legitimní, ale ani jeden objekt téhle fixtury je
      // nemá — kompozice i tvar kotvy dostanou. Kdyby zmizely, je to vada
      // slotů, ne kreslení, a musí se ozvat tady.
      expect(slot.anchors.length, `${slot.stableId} přišel o kotvy`).toBeGreaterThan(0);
      expect(slot.sockets.map((socket) => socket.name)).toEqual(
        slot.anchors.map((anchor) => anchor.name),
      );

      for (const anchor of slot.anchors) {
        const socket = slot.sockets.find((candidate) => candidate.name === anchor.name)!;
        const expected = toWorld(slot.transform, anchor.at);
        for (let axis = 0; axis < 3; axis += 1) {
          expect(socket.at[axis], `${slot.stableId}/${anchor.name} osa ${axis}`).toBeCloseTo(
            expected[axis],
            5,
          );
        }
      }
    }
  });

  test('kulisa se kreslí jednou a vedle slotů, ne uvnitř nich', async ({ page }) => {
    await openStage(page);
    const scenery = await page.evaluate(() => window.__worldstreamStage!.scenery());

    // Ukázková kompozice má devět rozsetých keřů a tři podstavce, které si
    // nenárokoval žádný objekt, takže kulisa vzniknout musí.
    expect(scenery.present, 'kulisa nevznikla, přestože kompozici nikdo nerozebral celou').toBe(
      true,
    );
    expect(scenery.groups, 'kulisa je na scéně vícekrát').toBe(1);
    expect(scenery.triangles).toBeGreaterThan(0);
    expect(scenery.drawCalls).toBeGreaterThan(0);
    expect(scenery.slotNodes, 'kulisa kreslí kus, který si nárokoval slot').toBe(0);
  });

  test('stará herní scéna se do mostu nezaplétá', () => {
    const source = readFileSync(join('src', 'components', 'viewer', 'WorldScene.tsx'), 'utf8');

    // Lexikální, protože jde o **rozhodnutí**, ne o chování: worldstream má
    // vlastní scénu a `WorldScene.tsx` zůstává starou herní cestou. Kdyby se
    // sem sloty přece jen vestavěly, spadne to tady, ne o dvě úlohy dál.
    for (const forbidden of ['RepresentationSlot', 'buildProxyWorld', 'WorldstreamStage']) {
      expect(source, `WorldScene.tsx sáhl na ${forbidden}`).not.toContain(forbidden);
    }
  });
});
