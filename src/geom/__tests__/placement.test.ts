import { describe, expect, it } from 'vitest';
import { Matrix4, type BufferGeometry } from 'three';

import { compileGeomProgram, trianglesOfGeometry } from '../compile';
import { FAMILIES } from '../families';
import { bakePlacements, compilePlacements } from '../placements';
import { GEOM_LIMITS, GEOM_VERSION, instanceCounts, type GeomProgram } from '../program';

/**
 * Plán rozmístění musí dát **týž svět** jako slučující kompilátor.
 *
 * Je to nová cesta k témuž výsledku a její vada by se projevila jako posunutá
 * kulisa — což vypadá jako výtvarné rozhodnutí, ne jako chyba. Shoda vrchol po
 * vrcholu se starou cestou je jediná kontrola, která to odhalí, a proto stojí
 * nad každým uzlem, který kompilátor umí, i nad všemi čtyřmi rodinami.
 */

const program = (nodes: GeomProgram['nodes'], root: number): GeomProgram => ({
  version: GEOM_VERSION,
  nodes,
  root,
});

/** Největší odchylka jednoho čísla mezi dvěma atributy — a kde leží. */
function worstDifference(
  actual: BufferGeometry,
  expected: BufferGeometry,
  name: 'position' | 'color' | 'normal',
): { readonly delta: number; readonly at: number } {
  const left = actual.getAttribute(name).array as Float32Array;
  const right = expected.getAttribute(name).array as Float32Array;
  let delta = 0;
  let at = -1;
  for (let index = 0; index < right.length; index += 1) {
    const difference = Math.abs(left[index] - right[index]);
    if (difference > delta) {
      delta = difference;
      at = index;
    }
  }
  return { delta, at };
}

function expectSameGeometry(actual: BufferGeometry, expected: BufferGeometry): void {
  expect(trianglesOfGeometry(actual)).toBe(trianglesOfGeometry(expected));
  for (const name of ['position', 'color', 'normal'] as const) {
    const { delta, at } = worstDifference(actual, expected, name);
    // Jedno tvrzení místo statisíců: nese jméno atributu, index nejhoršího
    // čísla a jeho odchylku, takže rozdíl je vidět rovnou z hlášky.
    const worst = delta > 1e-4 ? `${name}[${at}] off by ${delta}` : `${name} matches`;
    expect(worst).toBe(`${name} matches`);
  }
}

/** `carve` zahazuje trojúhelníky, takže z podstromu udělá jednu síť místo kusů. */
const carves = (source: GeomProgram): boolean =>
  source.nodes.some((node) => node.kind === 'carve');

const PROGRAMS: ReadonlyArray<readonly [string, GeomProgram]> = [
  ['holy-kus', program([{ kind: 'mass', variant: 'block' }], 0)],
  [
    'kus-se-vsemi-udaji',
    program(
      [{ kind: 'column', variant: 'twisted', at: [1.5, 2, -3], yaw: 3, scale: [2, 0.5, 1.25] }],
      0,
    ),
  ],
  [
    'rada-kusu',
    program(
      [
        { kind: 'panel', variant: 'wall', at: [0, 1, 0], yaw: 1 },
        { kind: 'repeat', child: 0, count: 6, step: [2.5, 0, 0] },
      ],
      1,
    ),
  ],
  [
    'zrcadlo-x',
    program(
      [
        { kind: 'arch', variant: 'portal', at: [3, 0, 0], scale: [1.5, 1.5, 1.5] },
        { kind: 'mirror', child: 0, axis: 'x' },
      ],
      1,
    ),
  ],
  [
    'zrcadlo-z-mimo-osu',
    program(
      [
        { kind: 'mass', variant: 'wedge', at: [0, 0, 4] },
        { kind: 'repeat', child: 0, count: 3, step: [1, 0.5, 0] },
        { kind: 'mirror', child: 1, axis: 'z', about: 2.5 },
      ],
      2,
    ),
  ],
  [
    'zrcadlo-v-zrcadle',
    program(
      [
        { kind: 'column', variant: 'fluted', at: [2, 0, 2] },
        { kind: 'mirror', child: 0, axis: 'x', about: 1 },
        { kind: 'mirror', child: 1, axis: 'z' },
      ],
      2,
    ),
  ],
  [
    'rozsety-les',
    program(
      [
        { kind: 'organic', variant: 'tree', scale: [1.4, 2.2, 1.4] },
        { kind: 'scatter', child: 0, count: 14, radius: 9.5, seed: 8_461_207 },
      ],
      1,
    ),
  ],
  [
    'prosekana-zed',
    program(
      [
        { kind: 'panel', variant: 'wall', at: [0, 1.5, 0], scale: [3, 3, 3] },
        { kind: 'mirror', child: 0, axis: 'x', about: 2 },
        { kind: 'carve', child: 1, at: [2, 1.5, 0], size: [2, 3, 4] },
      ],
      2,
    ),
  ],
  [
    'skupina-vrstev',
    program(
      [
        { kind: 'terrain', variant: 'basin', extent: [24, 24], amplitude: 1.5, seed: 4_121 },
        { kind: 'mass', variant: 'plinth', at: [0, 0.5, 0], scale: [4, 1, 4] },
        { kind: 'organic', variant: 'shrub' },
        { kind: 'scatter', child: 2, count: 9, radius: 8, seed: 990_733 },
        { kind: 'group', children: [0, 1, 3] },
      ],
      4,
    ),
  ],
  [
    'rada-skupin',
    program(
      [
        { kind: 'mass', variant: 'step', at: [0, 0, 0] },
        { kind: 'column', variant: 'post', at: [0, 1, 0], yaw: 2 },
        { kind: 'group', children: [0, 1] },
        { kind: 'repeat', child: 2, count: 4, step: [0, 0, 3] },
      ],
      3,
    ),
  ],
  ...(['flat', 'ridge', 'basin', 'plateau'] as const).map(
    (variant) =>
      [
        `zem-${variant}`,
        program(
          [
            {
              kind: 'terrain',
              variant,
              extent: [18, 12],
              amplitude: 2,
              seed: 31_337,
              at: [1, 0, -2],
              yaw: 1,
            },
          ],
          0,
        ),
      ] as const,
  ),
  ...FAMILIES.map((family) => [`rodina-${family.id}`, family.compose(20_260_825)] as const),
];

const byName = (name: string): GeomProgram => {
  const found = PROGRAMS.find(([label]) => label === name);
  if (found === undefined) throw new Error(`test odkazuje na program ${name}, který v seznamu není`);
  return found[1];
};

describe('compilePlacements', () => {
  describe('složením týchž kusů týmiž maticemi vznikne táž geometrie', () => {
    for (const [name, source] of PROGRAMS) {
      it(name, () => {
        const expected = compileGeomProgram(source);
        const baked = bakePlacements(compilePlacements(source));
        expectSameGeometry(baked, expected);
      });
    }
  });

  describe('plán je rozpočtem omezený seznam kusů', () => {
    for (const [name, source] of PROGRAMS) {
      it(name, () => {
        const placements = compilePlacements(source);
        expect(placements.length).toBeGreaterThan(0);
        expect(placements.length).toBeLessThanOrEqual(GEOM_LIMITS.maxInstances);
        // `carve` zahodí trojúhelníky, takže podstrom skončí jako jedna síť a
        // kusů je míň, než kolik jich rozpočet napočítal. Jinde se to musí
        // rovnat — jinak plán mlčky ztratil nebo přidal kus.
        const expanded = instanceCounts(source.nodes)[source.root];
        if (carves(source)) expect(placements.length).toBeLessThan(expanded);
        else expect(placements.length).toBe(expanded);
      });
    }
  });

  it('kus kitu se pozná jménem, zem a řez sítí', () => {
    const placements = compilePlacements(byName('skupina-vrstev'));
    const pieces = placements.filter((placement) => placement.kind === 'piece');
    const meshes = placements.filter((placement) => placement.kind === 'mesh');
    expect(meshes).toHaveLength(1);
    expect(pieces.map((piece) => piece.pieceId)).toEqual([
      'mass.plinth',
      ...Array.from({ length: 9 }, () => 'organic.shrub'),
    ]);
  });

  /**
   * Bez tohohle tvrzení nikdo nehlídá, **kam** kus doopravdy padne.
   *
   * Shoda se slučující cestou to neumí: obě cesty berou matici z téhož
   * `placementMatrix()`, takže když se v něm prohodí pořadí, svět se otočí i
   * zvětší špatně a obě cesty se pohnou stejně — naměřeno 26. 8. 2026, oba
   * soubory zůstaly zelené. Očekávaná matice se proto skládá tady a ručně.
   */
  it('kus padne tam, kam ho program posílá — posun, otočení, měřítko, v tomhle pořadí', () => {
    const source = program(
      [{ kind: 'mass', variant: 'block', at: [4, 0.5, -3], yaw: 1, scale: [2, 1, 3] }],
      0,
    );
    const expected = new Matrix4()
      .makeTranslation(4, 0.5, -3)
      .multiply(new Matrix4().makeRotationY(Math.PI / 2))
      .multiply(new Matrix4().makeScale(2, 1, 3));

    const [placement] = compilePlacements(source);
    placement.matrix.toArray().forEach((value, index) => {
      expect(value).toBeCloseTo(expected.toArray()[index], 6);
    });
  });

  it('zrcadlený kus je označený, nezrcadlený ne', () => {
    const placements = compilePlacements(byName('zrcadlo-x'));
    expect(placements.map((placement) => placement.mirrored)).toEqual([false, true]);
  });

  it('dvojí zrcadlení vinutí vrátí zpátky', () => {
    const placements = compilePlacements(byName('zrcadlo-v-zrcadle'));
    expect(placements.map((placement) => placement.mirrored)).toEqual([false, true, true, false]);
  });

  it('týž program dá dvakrát týž plán', () => {
    const source = byName('rozsety-les');
    const first = compilePlacements(source);
    const second = compilePlacements(source);
    expect(first.map((placement) => placement.matrix.toArray())).toEqual(
      second.map((placement) => placement.matrix.toArray()),
    );
  });

  describe('cesty selhání', () => {
    it('program nad maxInstances se odmítne', () => {
      const source = program(
        [
          { kind: 'organic', variant: 'pebble' },
          { kind: 'scatter', child: 0, count: 11, radius: 6, seed: 1 },
          { kind: 'repeat', child: 1, count: 12, step: [1, 0, 0] },
        ],
        2,
      );
      expect(instanceCounts(source.nodes)[2]).toBeGreaterThan(GEOM_LIMITS.maxInstances);
      expect(() => compilePlacements(source)).toThrow(/maxInstances/);
    });

    it('skupina bez potomků se odmítne', () => {
      expect(() => compilePlacements(program([{ kind: 'group', children: [] }], 0))).toThrow(
        /invalid geom program/,
      );
    });

    it('scatter s nulovým počtem se odmítne', () => {
      const scatter = { kind: 'scatter', child: 0, count: 0, radius: 4, seed: 7 };
      const source = program(
        [
          { kind: 'organic', variant: 'reed' },
          scatter as unknown as GeomProgram['nodes'][number],
        ],
        1,
      );
      expect(() => compilePlacements(source)).toThrow(/invalid geom program/);
    });

    it('řez, po kterém nic nezbude, se odmítne stejně jako u slučujícího kompilátoru', () => {
      const source = program(
        [
          { kind: 'mass', variant: 'block' },
          { kind: 'carve', child: 0, at: [0, 0, 0], size: [64, 64, 64] },
        ],
        1,
      );
      expect(() => compileGeomProgram(source)).toThrow(/empty geometry/);
      expect(() => compilePlacements(source)).toThrow(/empty geometry/);
    });
  });
});
