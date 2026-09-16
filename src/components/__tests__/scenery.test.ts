import { Box3, InstancedMesh, Matrix4, Mesh, MeshToonMaterial, type Group } from 'three';
import { afterAll, describe, expect, it } from 'vitest';

import { buildScenery } from '@/components/viewer/scenery';
import { CELL_SIZE } from '@/components/viewer/projection';
import { FILL_RINGS } from '@/components/viewer/dressing';
import { FAMILIES } from '@/geom/families';
import { compilePlacements } from '@/geom/placements';
import { KIT_BUDGETS, PALETTES } from '@/kit';
import { shadeForRole } from '@/components/viewer/ClayMaterial';
import {
  WORLDSTREAM_FILL_LIGHT,
  WORLDSTREAM_KEY_LIGHT,
} from '@/components/viewer/WorldstreamLighting';

/**
 * Kulisa musí stát **za** hrací plochou a vejít se do rozpočtu.
 *
 * Špatně umístěná kulisa je vidět okamžitě — kdyby ležela přes mřížku, nikdo by
 * ji nepřehlédl. **Překročený rozpočet vidět není** a projeví se až propadem
 * snímků na slabším stroji, takže ho hlídá tenhle test: jedno kreslicí volání
 * na id kusu a strop trojúhelníků na svět.
 *
 * Měří se skutečná stavba, ne plán — geometrie se opravdu postaví a obal se
 * spočítá z instančních matic, protože právě tam se překryv s mřížkou skrývá.
 */

const material = new MeshToonMaterial({ vertexColors: true });
afterAll(() => material.dispose());

const GRID = { width: 12, height: 8 };
const SEED = 20_260_826;

/**
 * Naměřená cena kulisy, 28. 8. 2026, semínko `SEED` a mřížka 12×8.
 *
 * **Připnuté schválně, ať se každý pohyb ozve.** Když se ozvou, **zapiš proč**,
 * nikdy je jen nepřepiš.
 *
 * **Proč se pohnula z 26. 8. 2026** (`4/1 598`, `4/3 042`, `5/3 194`,
 * `3/1 222`): vlna 3 T6 zahustila rodiny, protože kulisa nesla jednotky procent
 * rozpočtu. Terasy dostaly pás zábradlí a rozseté zkosené kvádry, Věže o patro
 * a o věž víc a dvakrát tolik sloupů kolem, Háj podrost ze shluků, Hutě `window`
 * místo `wall` (tytéž rozměry, pětkrát víc trojúhelníků) a pevný počet lodí.
 * Kreslicí volání přibyla jen tam, kde přibylo **nové id kusu** — Terasy 4 → 6,
 * Háj 5 → 6; Věže a Hutě žádné nové id nemají a stojí na svém.
 *
 * Háj se v téže úloze hnul **podruhé**, `4 982 → 5 062`: `e2e/divergence.spec.ts`
 * naměřil profil dvou semínek 0,0129 proti stropu 0,012, takže se počty porostu
 * ustálily na pevných a losuje se jen počet balvanů. Práh se nehnul, hnula se
 * rodina.
 *
 * **Proč se pohnula z 27. 8. 2026** (`6/4 186`, `4/4 298`, `6/5 062`,
 * `3/3 482`): P14 T5 postavila do každé rodiny postavu a drobnosti. Do té doby
 * nebylo v žádném vygenerovaném světě nic, podle čeho se dá odhadnout měřítko —
 * deska o hraně 7,6 vypadala stejně jako deska o hraně 76.
 *
 * **Kreslicí volání přibyla přesně za nové druhy kusů**, protože kulisa
 * instancuje po id kusu: Terasy `actor.squat`, `fixture.crate`,
 * `fixture.barrel` = 3 nové druhy, 6 → 9. Věže `actor.tall`, `fixture.lamp`,
 * `fixture.sign` = 3, 4 → 7. Háj `actor.quadruped`, `fixture.bench`,
 * `fixture.lamp` = 3, 6 → 9. Hutě `actor.drone`, `fixture.pipe`,
 * `fixture.terminal`, `fixture.hatch` = 4, 3 → 7. Trojúhelníky přibyly za
 * samotné kusy: +188, +152, +176, +232.
 */
const MEASURED: Readonly<Record<string, { readonly drawCalls: number; readonly triangles: number }>> = {
  terraces: { drawCalls: 9, triangles: 4_374 },
  spires: { drawCalls: 7, triangles: 4_450 },
  grove: { drawCalls: 9, triangles: 5_238 },
  works: { drawCalls: 7, triangles: 3_714 },
};

/**
 * Obal skupiny **včetně instančních matic**.
 *
 * Počítá se ručně schválně: obal `InstancedMesh` je v `three` obalem jedné
 * kopie geometrie, ne rozsetých instancí, takže hotové `setFromObject` by
 * kulisu nahlásilo mnohem menší, než doopravdy je — a překryv s mřížkou je
 * přesně to, co se tu hlídá.
 */
function boundsOf(group: Group): Box3 {
  const box = new Box3();
  const matrix = new Matrix4();
  group.updateMatrixWorld(true);

  group.traverse((node) => {
    if (node instanceof InstancedMesh) {
      node.geometry.computeBoundingBox();
      for (let index = 0; index < node.count; index += 1) {
        node.getMatrixAt(index, matrix);
        matrix.premultiply(node.matrixWorld);
        box.union(node.geometry.boundingBox!.clone().applyMatrix4(matrix));
      }
      return;
    }
    if (node instanceof Mesh) {
      node.geometry.computeBoundingBox();
      box.union(node.geometry.boundingBox!.clone().applyMatrix4(node.matrixWorld));
    }
  });

  return box;
}

describe('buildScenery', () => {
  for (const family of FAMILIES) {
    describe(family.id, () => {
      it('postaví kulisu a vejde se do rozpočtu světa', () => {
        const built = buildScenery(family.id, SEED, GRID, material);
        expect(built.object, `${family.id} nepostavil nic`).not.toBeNull();
        expect(built.family).toBe(family.id);
        expect(built.triangles).toBeGreaterThan(0);
        expect(built.drawCalls).toBeGreaterThan(0);
        expect(
          built.drawCalls,
          `${family.id} přidá ${built.drawCalls} kreslicích volání`,
        ).toBeLessThanOrEqual(KIT_BUDGETS.maxDrawCallsPerWorld);
        expect(
          built.triangles,
          `${family.id} přidá ${built.triangles} trojúhelníků`,
        ).toBeLessThanOrEqual(KIT_BUDGETS.maxTrianglesPerWorld);
        built.dispose();
      });

      it('stojí přesně tolik, kolik bylo naměřeno', () => {
        const built = buildScenery(family.id, SEED, GRID, material);
        expect({ drawCalls: built.drawCalls, triangles: built.triangles }).toEqual(
          MEASURED[family.id],
        );
        built.dispose();
      });

      it('postaví aspoň jednu postavu a aspoň dvě drobnosti', () => {
        // **Měřítko.** Bez postavy se u žádné rodiny nedá odhadnout, jak je
        // svět velký; drobnosti dělají totéž o patro níž a říkají „sem někdo
        // chodí". Do 28. 8. 2026 tu nebylo ani jedno, protože `fixture`
        // a `actor` neměly variantu v `PIECE_VARIANTS` (odemkla T4).
        //
        // **Soudí se nad zkompilovanými umístěními, ne nad uzly programu.**
        // Uzel může v programu existovat a do scény se nedostat — stačí, aby ho
        // kořenová `group` nevyjmenovala mezi dětmi, a je neviditelný. Tenhle
        // seznam je naopak přesně to, co se vykreslí.
        const placements = compilePlacements(family.compose(SEED));
        const ids = placements
          .filter((placement) => placement.kind === 'piece')
          .map((placement) => placement.pieceId);

        const actors = ids.filter((id) => id.startsWith('actor.'));
        const fixtures = ids.filter((id) => id.startsWith('fixture.'));

        expect(
          actors.length,
          `${family.id} nemá ve scéně postavu, takže v něm nejde odhadnout měřítko`,
        ).toBeGreaterThanOrEqual(1);
        expect(
          fixtures.length,
          `${family.id} má jen ${fixtures.length} drobnost(i): ${fixtures.join(', ')}`,
        ).toBeGreaterThanOrEqual(2);
      });

      it('leží celá za posledním prstencem výplně, ne jen za mřížkou', () => {
        // Od vlny 3 T6 nekončí svět hranou mřížky: `FILL_RINGS` prstenců kusů
        // stojí za ní. Kdyby se tahle hranice počítala jen z mřížky, ležela by
        // krajina na výplni — a byla by to vada, kterou v Node nikdo nevidí,
        // protože obě vrstvy se staví zvlášť.
        const built = buildScenery(family.id, SEED, GRID, material);
        const box = boundsOf(built.object as Group);
        const farEdge = -(GRID.height * CELL_SIZE) / 2 - FILL_RINGS * CELL_SIZE;
        expect(
          box.max.z,
          `${family.id} zasahuje na výplň nebo na hrací plochu: nejbližší hrana ` +
            `${box.max.z.toFixed(2)}, vzdálená hrana výplně ${farEdge.toFixed(2)}`,
        ).toBeLessThan(farEdge);
        built.dispose();
      });

      it('žádná instance nezrcadlí — jinak by se ten kus vykreslil naruby', () => {
        // Zrcadlená matice má záporný determinant a `MeshToonMaterial` se
        // `side: FrontSide` by takový kus odřízl jako odvrácený. Zapečená síť
        // to řeší obrácením vinutí; instancovaná dávka to udělat neumí, takže
        // do ní zrcadlený kus nesmí. Naměřeno 26. 8. 2026: bez tohohle tvrzení
        // přesun zrcadlených kusů do instancí prošel všemi 20 testy zeleně.
        const built = buildScenery(family.id, SEED, GRID, material);
        const matrix = new Matrix4();
        const flipped: string[] = [];

        (built.object as Group).traverse((node) => {
          if (!(node instanceof InstancedMesh)) return;
          for (let index = 0; index < node.count; index += 1) {
            node.getMatrixAt(index, matrix);
            if (matrix.determinant() < 0) flipped.push(`${node.name}#${index}`);
          }
        });

        expect(flipped, `zrcadlené instance: ${flipped.join(', ')}`).toEqual([]);
        built.dispose();
      });

      it('sedí pod pochozí rovinou, ne nad ní', () => {
        const built = buildScenery(family.id, SEED, GRID, material);
        expect((built.object as Group).position.y).toBeLessThan(0);
        built.dispose();
      });
    });
  }

  it('týž svět dá dvakrát tutéž kulisu', () => {
    const first = buildScenery('terraces', SEED, GRID, material);
    const second = buildScenery('terraces', SEED, GRID, material);
    expect(first.triangles).toBe(second.triangles);
    expect(first.drawCalls).toBe(second.drawCalls);
    expect((first.object as Group).position.toArray()).toEqual(
      (second.object as Group).position.toArray(),
    );
    first.dispose();
    second.dispose();
  });

  it('jiné semínko dá jinou kulisu téže rodiny', () => {
    const first = buildScenery('grove', SEED, GRID, material);
    const second = buildScenery('grove', SEED + 1, GRID, material);
    expect(first.triangles).not.toBe(second.triangles);
    first.dispose();
    second.dispose();
  });

  it('širší mřížka odsune kulisu dál', () => {
    const narrow = buildScenery('works', SEED, GRID, material);
    const deep = buildScenery('works', SEED, { width: 12, height: 20 }, material);
    expect((deep.object as Group).position.z).toBeLessThan((narrow.object as Group).position.z);
    narrow.dispose();
    deep.dispose();
  });

  it('neznámá rodina nechá scénu bez kulisy, nevyhodí', () => {
    const built = buildScenery('no-such-family', SEED, GRID, material);
    expect(built.object).toBeNull();
    expect(built.drawCalls).toBe(0);
    expect(built.triangles).toBe(0);
    built.dispose();
  });
});

/**
 * Světlo a hmota — P18 T3.
 *
 * **Snímky z živých běhů ukazují šedé desky na jednom odstínu**, a příčina není
 * ve světlech: rig má čtyři a mlhu. Je v materiálu — `buildRough()` dává
 * hrdinům i hliněným kvádrům `clayMaterial()` **bez odstínu**, takže se celý
 * svět vykreslí jednou barvou hlíny. Paletu a barvy ve vrcholech dostanou dnes
 * jen kusy kitu.
 *
 * Proto se tu měří dvě věci naráz: že světla vůbec svítí (to je levná pojistka
 * proti tomu, aby výtvarné ladění některé z nich omylem zhaslo) a že **role
 * slotu rozhoduje o odstínu**. Druhé je ta vlastnost, kterou z hotového snímku
 * nikdo nepojmenuje: obraz vypadá jako obraz, jen jsou v něm všechny věci
 * stejné.
 */
describe('hmota čte roli slotu', () => {
  /** Odstín ve stupních, 0 je červená. Fialové pásmo je 250–320°. */
  function hueOf(hex: string): number {
    const value = Number.parseInt(hex.replace('#', ''), 16);
    const r = ((value >> 16) & 255) / 255;
    const g = ((value >> 8) & 255) / 255;
    const b = (value & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const span = max - min;
    if (span === 0) return 0;
    const raw =
      max === r ? (g - b) / span : max === g ? 2 + (b - r) / span : 4 + (r - g) / span;
    return ((raw * 60) % 360 + 360) % 360;
  }

  it('klíčové i doplňkové světlo doopravdy svítí', () => {
    expect(WORLDSTREAM_KEY_LIGHT.intensity).toBeGreaterThan(0);
    expect(WORLDSTREAM_FILL_LIGHT.intensity).toBeGreaterThan(0);
  });

  it('terén, architektura a hrdina dostanou každý jiný odstín', () => {
    // `wall` z AC úlohy mezi rolemi není — `INTENT_ROLES` je
    // `architecture · hero · prop · terrain · effect`, a zeď je architektura.
    const terrain = shadeForRole('terrain', PALETTES.harbor);
    const architecture = shadeForRole('architecture', PALETTES.harbor);
    const hero = shadeForRole('hero', PALETTES.harbor);

    expect(new Set([terrain, architecture, hero]).size, 'role se slily do jednoho odstínu').toBe(3);
  });

  it('každá role vrací odstín z palety, ne vlastní hex', () => {
    // Odstín mimo paletu by `repaint()` odmítl a kus by se nevykreslil vůbec.
    const swatches = new Set(Object.values(PALETTES.harbor));
    for (const role of ['architecture', 'hero', 'prop', 'terrain', 'effect'] as const) {
      expect(swatches, `role ${role} má odstín mimo paletu`).toContain(
        shadeForRole(role, PALETTES.harbor),
      );
    }
  });

  it('žádná role nesáhne po fialové, v žádné paletě', () => {
    // Globální pravidlo designu. Hlídá se strojově, ne komentářem.
    for (const palette of Object.values(PALETTES)) {
      for (const role of ['architecture', 'hero', 'prop', 'terrain', 'effect'] as const) {
        const hue = hueOf(shadeForRole(role, palette));
        expect(hue < 250 || hue > 320, `role ${role} má fialový odstín ${hue.toFixed(0)}°`).toBe(
          true,
        );
      }
    }
  });
});
