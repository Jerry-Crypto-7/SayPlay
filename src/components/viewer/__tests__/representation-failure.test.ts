/**
 * **Co ve scéně zůstane, když detail nedorazí** (P15 T21, design book §13.3 bod 7).
 *
 * Šťastnou cestu výměny podoby soudí `representation.test.ts` a odhalení
 * `materialize.test.ts`. Tenhle soubor se ptá na jedinou věc, kterou šťastné
 * demo neukáže nikdy: **selhání nesmí být horší než nepokus.** Hrubá podoba
 * stojí dál, nikdo jí nesáhl na krytí, a odmítnutý kandidát nedrží ani
 * geometrii, ani místo ve scéně.
 *
 * ## Odmítnutý kandidát se soudí přes scénu, ne přes návratovou hodnotu
 *
 * `outcome.refusal` je to, co registry **říká**. Že se odmítnutý uzel doopravdy
 * nikdy neobjevil mezi dětmi obalu, se z návratové hodnoty přečíst nedá — a
 * přesně tam je vada, kterou porotce uvidí: jeden snímek s cizím tvarem.
 * Každý případ níž proto čte `group.children` a `parent`.
 *
 * ## Co tady nejde a měří to e2e
 *
 * **Transferable buffery z workeru.** Kandidát se tu skládá z obyčejné
 * `BoxGeometry`, protože `geometryFromMesh()` bydlí uvnitř `WorldstreamStage`
 * a s ním by se do jednotkové sady natáhl celý R3F. Že se pole přenesená
 * z workeru po výměně nehromadí, se dá číst jedině z rendereru —
 * `e2e/worldstream-resilience.spec.ts` a jeho `memory()`.
 */

import { BoxGeometry, Mesh, MeshBasicMaterial, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import type { Bounds3 } from '../../../shape/types';
import type { SemanticObject } from '../../../worldstream/schema';
import { slotFromForm, type SemanticSlot } from '../../../worldstream/slots';
import { applyReveal } from '../Materialize';
import {
  createRepresentationRegistry,
  type RepresentationCandidate,
  type RepresentationRegistry,
} from '../representation';

/* ------------------------------------------------------------------ *
 * Fixtura — stejná jako v `representation.test.ts`, aby se dva soubory
 * o téže scéně nerozešly v tom, co je „normální slot".
 * ------------------------------------------------------------------ */

const LOCAL: Bounds3 = { min: [-1, 0, -0.5], max: [1, 3, 0.5] };

function object(stableId: string): SemanticObject {
  return {
    stableId,
    label: 'leviathan ribs',
    synonyms: ['ribs'],
    role: 'hero',
    source: { kind: 'shape', shapeId: 'ribs' },
    targetBounds: { min: [4, 0, 2], max: [11, 21.75, 3.3] },
    importance: 3,
  };
}

function slotOf(stableId = 'hero'): SemanticSlot {
  return slotFromForm(object(stableId), {
    localBounds: LOCAL,
    anchors: [{ name: 'base', at: [0, 0, 0], normal: [0, -1, 0] }],
  });
}

/** Mesh s vlastní geometrií i materiálem, aby šlo počítat, co se odložilo. */
function shape(name: string): Mesh<BoxGeometry, MeshBasicMaterial> {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.name = name;
  return mesh;
}

function candidate(overrides: Partial<RepresentationCandidate> = {}): RepresentationCandidate {
  return {
    stableId: 'hero',
    revision: 0,
    contentHash: 'hash-b',
    bounds: LOCAL,
    object: shape('candidate'),
    ...overrides,
  };
}

/**
 * Podoby v obalu. **Sockety se nepočítají** — ty v něm bydlí od `open()`,
 * výměna podoby s nimi nehýbe a počítat je by jen zašumělo číslo, o které jde.
 */
function forms(group: Object3D): Object3D[] {
  return group.children.filter((child) => (child as { isMesh?: boolean }).isMesh === true);
}

/** Slot s hlínou a nic víc. Výchozí stav každého případu níž. */
function openSlot(): {
  registry: RepresentationRegistry;
  rough: Mesh<BoxGeometry, MeshBasicMaterial>;
} {
  const registry = createRepresentationRegistry();
  const rough = shape('clay');
  registry.open(slotOf(), rough);
  return { registry, rough };
}

/* ------------------------------------------------------------------ *
 * Odmítnutý kandidát.
 * ------------------------------------------------------------------ */

interface RefusalCase {
  readonly name: string;
  readonly refusal: string;
  readonly build: (registry: RepresentationRegistry) => RepresentationCandidate;
}

/**
 * Všechny cesty, kterými `stage()` kandidáta odmítne.
 *
 * Je to **uzavřený seznam**, ne výběr: každá z nich odkládá vlastním řádkem
 * kódu, takže vynechaná větev je přesně ta, ve které jednou zůstane
 * nepoložená geometrie.
 */
const REFUSALS: readonly RefusalCase[] = [
  {
    name: 'kandidát pro slot, který neexistuje',
    refusal: 'UNKNOWN_SLOT',
    build: () => candidate({ stableId: 'nobody' }),
  },
  {
    name: 'výsledek objednaný před tím, než porotce objekt odvolal',
    refusal: 'STALE_REVISION',
    build: (registry) => {
      registry.revise('hero');
      return candidate({ revision: 0 });
    },
  },
  {
    name: 'blob, který přerostl svůj slot',
    refusal: 'BOUNDS_MISMATCH',
    build: () => candidate({ bounds: { min: [-6, 0, -3], max: [6, 18, 3] } }),
  },
  {
    name: 'kvádr o nulové hloubce, tedy nic k vykreslení',
    refusal: 'BOUNDS_DEGENERATE',
    build: () => candidate({ bounds: { min: [-1, 0, 0], max: [1, 3, 0] } }),
  },
];

describe('odmítnutý detail', () => {
  for (const { name, refusal, build } of REFUSALS) {
    it(`${name} se ani nedotkne scény (${refusal})`, () => {
      const { registry, rough } = openSlot();
      const group = registry.view('hero')!.group;
      const detail = build(registry);

      const outcome = registry.stage(detail);

      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.refusal).toBe(refusal);
      // Tohle je ta věta „nesmí ani krátce bliknout": uzel se do obalu nikdy
      // nedostal, takže neexistuje snímek, na kterém by ho scéna kreslila.
      expect(detail.object.parent).toBeNull();
      expect(forms(group)).toEqual([rough]);
      // Odmítnutý artefakt drží geometrii na GPU, dokud ho někdo nepoloží.
      expect(outcome.deferred).toEqual({ geometries: 1, materials: 1, textures: 0 });

      // A hlína stojí přesně tak, jak stála.
      expect(rough.visible).toBe(true);
      expect(rough.material.transparent).toBe(false);
      expect(rough.material.opacity).toBe(1);
      expect(registry.view('hero')!.attached).toBe(rough);
      expect(registry.view('hero')!.staged).toBeNull();
      expect(registry.view('hero')!.contentHash).toBeNull();
    });
  }

  it('po odmítnutí je slot použitelný dál, ne zaseknutý', () => {
    const { registry } = openSlot();
    registry.stage(candidate({ bounds: { min: [-6, 0, -3], max: [6, 18, 3] } }));

    const second = shape('detail');
    expect(registry.stage(candidate({ object: second })).ok).toBe(true);
    expect(registry.commit('hero').ok).toBe(true);
    expect(registry.view('hero')!.attached).toBe(second);
  });
});

/* ------------------------------------------------------------------ *
 * Odhalení, které se nedokončí.
 * ------------------------------------------------------------------ */

describe('zrušené odhalení', () => {
  it('hlína zůstane neprůhledná — odhalení jí nikdy nesáhlo na krytí', () => {
    const { registry, rough } = openSlot();
    const detail = shape('detail');
    registry.stage(candidate({ object: detail }));
    // Přesně to, co dělá `Materialize` v půlce přechodu.
    applyReveal(detail, 0.4);

    const tally = registry.abandon('hero');

    expect(rough.material.transparent).toBe(false);
    expect(rough.material.opacity).toBe(1);
    expect(rough.visible).toBe(true);
    expect(registry.view('hero')!.attached).toBe(rough);
    // Materiál kandidáta byl uprostřed odhalení průhledný a odkládá se i tak.
    expect(tally).toEqual({ geometries: 1, materials: 1, textures: 0 });
    expect(detail.parent).toBeNull();
  });

  it('druhý pokus po zrušeném odhalení projde celý', () => {
    const { registry } = openSlot();
    registry.stage(candidate({ object: shape('detail') }));
    registry.abandon('hero');

    const second = shape('second');
    expect(registry.stage(candidate({ object: second, contentHash: 'hash-c' })).ok).toBe(true);
    const outcome = registry.commit('hero');

    expect(outcome.ok).toBe(true);
    expect(registry.view('hero')!.attached).toBe(second);
    expect(registry.view('hero')!.contentHash).toBe('hash-c');
  });
});

/* ------------------------------------------------------------------ *
 * Opakovaná výměna.
 * ------------------------------------------------------------------ */

describe('dvacet pět výměn', () => {
  it('nechá ve slotu jednu podobu a odloží každou předchozí právě jednou', () => {
    const { registry } = openSlot();
    const group = registry.view('hero')!.group;
    let geometries = 0;
    let last: Mesh | null = null;

    for (let round = 1; round <= 25; round += 1) {
      const next = shape(`detail-${round}`);
      const staged = registry.stage(candidate({ object: next, contentHash: `hash-${round}` }));
      expect(staged.ok).toBe(true);
      const committed = registry.commit('hero');
      expect(committed.ok).toBe(true);
      if (committed.ok) geometries += committed.deferred.geometries;
      last = next;

      // Uprostřed, ne jen na konci: obal, který by na jeden kruh držel dvě
      // podoby, by se do součtu na konci nemusel promítnout vůbec.
      expect(forms(group)).toEqual([next]);
    }

    // Hlína plus dvacet čtyři vystřídaných podob. Dvacet pět proto, že poslední
    // ve slotu **zůstává** — kdyby jich odešlo dvacet pět, chybí ta na scéně.
    expect(geometries).toBe(25);
    expect(registry.view('hero')!.attached).toBe(last);
    expect(registry.view('hero')!.staged).toBeNull();
    expect(registry.view('hero')!.contentHash).toBe('hash-25');
  });
});
