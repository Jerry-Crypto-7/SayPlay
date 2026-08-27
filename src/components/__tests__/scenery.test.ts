import { Box3, InstancedMesh, Matrix4, Mesh, MeshToonMaterial, type Group } from 'three';
import { afterAll, describe, expect, it } from 'vitest';

import { buildScenery } from '@/components/viewer/scenery';
import { CELL_SIZE } from '@/components/viewer/projection';
import { FILL_RINGS } from '@/components/viewer/dressing';
import { FAMILIES } from '@/geom/families';
import { KIT_BUDGETS } from '@/kit';

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
 * Naměřená cena kulisy, 27. 8. 2026, semínko `SEED` a mřížka 12×8.
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
 */
const MEASURED: Readonly<Record<string, { readonly drawCalls: number; readonly triangles: number }>> = {
  terraces: { drawCalls: 6, triangles: 4_186 },
  spires: { drawCalls: 4, triangles: 4_298 },
  grove: { drawCalls: 6, triangles: 5_062 },
  works: { drawCalls: 3, triangles: 3_482 },
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
