import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Box3, BufferAttribute, BufferGeometry, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { KIT_BUDGETS, PALETTES, repaint } from '@/kit';
import {
  anchorPointOf,
  boundsOfGeometry,
  compileGeomProgram,
  placementMatrix,
  sweepGeometry,
  trianglesOfGeometry,
} from '../compile';
import {
  GEOM_LIMITS,
  GEOM_VERSION,
  MAX_CURVE_POINTS,
  MAX_SWEEP_SEGMENTS,
  ANCHOR_SITES,
  SWATCH_NAMES,
  instanceCounts,
  type AnchorSite,
  type GeomNode,
  type GeomProgram,
} from '../program';

const program = (nodes: GeomProgram['nodes'], root: number): GeomProgram => ({
  version: GEOM_VERSION,
  nodes,
  root,
});

/**
 * Dvacet programů, na kterých se dokazuje rozpočet.
 *
 * Není to náhodný vzorek — je to průřez tím, co kompilátor umí: sám kus, řada,
 * zrcadlená fasáda, prosekaná zeď, rozsetý les, čtyři terény a nakonec kusy
 * skládané blízko ke stropu. Kdyby se rozpočet dokazoval jen na malých
 * programech, dokazoval by, že malé programy jsou malé.
 */
const BUDGET_PROGRAMS: ReadonlyArray<readonly [string, GeomProgram]> = [
  ['jediny-kus', program([{ kind: 'mass', variant: 'block' }], 0)],
  ['sloup', program([{ kind: 'column', variant: 'pillar', scale: [1, 2, 1] }], 0)],
  ['branka', program([{ kind: 'arch', variant: 'doorway' }], 0)],
  ['strom', program([{ kind: 'organic', variant: 'tree' }], 0)],
  [
    'rada-sloupu',
    program(
      [
        { kind: 'column', variant: 'fluted' },
        { kind: 'repeat', child: 0, count: 8, step: [2, 0, 0] },
      ],
      1,
    ),
  ],
  [
    'schodiste',
    program(
      [
        { kind: 'mass', variant: 'step' },
        { kind: 'repeat', child: 0, count: 12, step: [0, 0.34, 1] },
      ],
      1,
    ),
  ],
  [
    'zrcadlena-fasada',
    program(
      [
        { kind: 'panel', variant: 'wall', at: [2, 0, 0] },
        { kind: 'repeat', child: 0, count: 4, step: [1, 0, 0] },
        { kind: 'mirror', child: 1, axis: 'x' },
      ],
      2,
    ),
  ],
  [
    'zrcadleni-kolem-roviny',
    program(
      [
        { kind: 'panel', variant: 'window', at: [3, 0, 0] },
        { kind: 'mirror', child: 0, axis: 'z', about: 4 },
      ],
      1,
    ),
  ],
  [
    'prosekana-zed',
    program(
      [
        { kind: 'panel', variant: 'wall' },
        { kind: 'repeat', child: 0, count: 5, step: [1, 0, 0] },
        { kind: 'carve', child: 1, at: [2, 0, 0], size: [1.1, 1.1, 2] },
      ],
      2,
    ),
  ],
  [
    'rozsety-les',
    program(
      [
        { kind: 'organic', variant: 'tree' },
        { kind: 'scatter', child: 0, count: 18, radius: 12, seed: 7 },
      ],
      1,
    ),
  ],
  [
    'balvany',
    program(
      [
        { kind: 'organic', variant: 'boulder', scale: [1.4, 1.4, 1.4] },
        { kind: 'scatter', child: 0, count: 9, radius: 8, seed: 21 },
      ],
      1,
    ),
  ],
  ['zem-rovina', program([{ kind: 'terrain', variant: 'flat', extent: [32, 32], amplitude: 0, seed: 1 }], 0)],
  ['zem-hreben', program([{ kind: 'terrain', variant: 'ridge', extent: [40, 24], amplitude: 4, seed: 2 }], 0)],
  ['zem-panev', program([{ kind: 'terrain', variant: 'basin', extent: [36, 36], amplitude: 3, seed: 3 }], 0)],
  ['zem-plosina', program([{ kind: 'terrain', variant: 'plateau', extent: [48, 48], amplitude: 5, seed: 4 }], 0)],
  [
    'nadvori',
    program(
      [
        { kind: 'terrain', variant: 'flat', extent: [28, 28], amplitude: 0.4, seed: 5 },
        { kind: 'column', variant: 'pillar' },
        { kind: 'repeat', child: 1, count: 6, step: [3, 0, 0] },
        { kind: 'mirror', child: 2, axis: 'z', about: 6 },
        { kind: 'arch', variant: 'portal', at: [7.5, 0, 6] },
        { kind: 'group', children: [0, 3, 4] },
      ],
      5,
    ),
  ],
  [
    'vez',
    program(
      [
        { kind: 'mass', variant: 'plinth' },
        { kind: 'repeat', child: 0, count: 10, step: [0, 1, 0] },
        { kind: 'mass', variant: 'bevel', at: [0, 10, 0] },
        { kind: 'group', children: [1, 2] },
      ],
      3,
    ),
  ],
  [
    'most',
    program(
      [
        { kind: 'arch', variant: 'round' },
        { kind: 'repeat', child: 0, count: 6, step: [1.6, 0, 0] },
        { kind: 'panel', variant: 'floor', at: [0, 1, 0] },
        { kind: 'repeat', child: 2, count: 8, step: [1.2, 0, 0] },
        { kind: 'group', children: [1, 3] },
      ],
      4,
    ),
  ],
  [
    'vesnice',
    program(
      [
        { kind: 'terrain', variant: 'basin', extent: [44, 44], amplitude: 2, seed: 6 },
        { kind: 'mass', variant: 'stack' },
        { kind: 'scatter', child: 1, count: 14, radius: 16, seed: 8 },
        { kind: 'organic', variant: 'shrub' },
        { kind: 'scatter', child: 3, count: 20, radius: 18, seed: 9 },
        { kind: 'group', children: [0, 2, 4] },
      ],
      5,
    ),
  ],
  [
    'blizko-stropu',
    program(
      [
        { kind: 'mass', variant: 'block' },
        { kind: 'repeat', child: 0, count: 14, step: [1, 0, 0] },
        { kind: 'repeat', child: 1, count: 8, step: [0, 0, 1] },
      ],
      2,
    ),
  ],
];

describe('kompilátor postaví z programu skutečnou geometrii', () => {
  it('vrátí neprázdnou geometrii se všemi třemi atributy', () => {
    const geometry = compileGeomProgram(BUDGET_PROGRAMS[16][1]);

    expect(trianglesOfGeometry(geometry)).toBeGreaterThan(0);
    expect(geometry.index).toBeNull();
    for (const name of ['position', 'color', 'normal']) {
      expect(geometry.getAttribute(name).count).toBe(geometry.getAttribute('position').count);
    }
  });

  it('normály jsou zapečené v geometrii a jednotkové', () => {
    // `MeshToonMaterial` nemá `flatShading`, takže stínování musí nést
    // geometrie. Nulová nebo neznormalizovaná normála je černý kus.
    const normal = compileGeomProgram(BUDGET_PROGRAMS[18][1]).getAttribute('normal');
    const vector = new Vector3();

    for (let index = 0; index < normal.count; index += 1) {
      vector.fromBufferAttribute(normal, index);
      expect(vector.length()).toBeCloseTo(1, 4);
    }
  });

  it('barvy vrcholů jsou odstíny kitu v lineárním prostoru', () => {
    // `repaint()` vyhodí na jakémkoli vrcholu, který nenese odstín kitu — je to
    // tedy zároveň důkaz, že barvy prošly `convertSRGBToLinear()`, a ne že se
    // do atributu zapsala surová sRGB čísla.
    const geometry = compileGeomProgram(BUDGET_PROGRAMS[18][1]);

    expect(() => repaint(geometry, PALETTES.harbor)).not.toThrow();
  });

  it('dvojí překlad téhož programu dá bajt po bajtu totéž', () => {
    const first = compileGeomProgram(BUDGET_PROGRAMS[18][1]).getAttribute('position').array;
    const second = compileGeomProgram(BUDGET_PROGRAMS[18][1]).getAttribute('position').array;

    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it('jiné semínko rozseje kopie jinam', () => {
    const seeded = (seed: number) =>
      Array.from(
        compileGeomProgram(
          program(
            [
              { kind: 'organic', variant: 'pebble' },
              { kind: 'scatter', child: 0, count: 6, radius: 9, seed },
            ],
            1,
          ),
        ).getAttribute('position').array,
      );

    expect(seeded(101)).not.toEqual(seeded(102));
  });
});

describe('operace dělají to, co slibují', () => {
  const trianglesOf = (doc: GeomProgram) => trianglesOfGeometry(compileGeomProgram(doc));

  it('repeat vyrobí tolik kopií, kolik říká count', () => {
    const one = trianglesOf(program([{ kind: 'mass', variant: 'block' }], 0));
    const seven = trianglesOf(
      program(
        [
          { kind: 'mass', variant: 'block' },
          { kind: 'repeat', child: 0, count: 7, step: [2, 0, 0] },
        ],
        1,
      ),
    );

    expect(seven).toBe(one * 7);
  });

  it('repeat kopie opravdu posouvá, nestaví je na sebe', () => {
    const geometry = compileGeomProgram(
      program(
        [
          { kind: 'mass', variant: 'block' },
          { kind: 'repeat', child: 0, count: 4, step: [3, 0, 0] },
        ],
        1,
      ),
    );
    geometry.computeBoundingBox();

    expect(geometry.boundingBox!.max.x - geometry.boundingBox!.min.x).toBeCloseTo(10, 5);
  });

  it('mirror zdvojí a druhou půlku převrátí kolem osy', () => {
    const geometry = compileGeomProgram(
      program(
        [
          { kind: 'panel', variant: 'wall', at: [4, 0, 0] },
          { kind: 'mirror', child: 0, axis: 'x' },
        ],
        1,
      ),
    );
    geometry.computeBoundingBox();

    expect(geometry.boundingBox!.min.x).toBeCloseTo(-geometry.boundingBox!.max.x, 5);
  });

  it('zrcadlená půlka má vinutí souhlasné s uloženou normálou', () => {
    // Bez obrácení vinutí by ji `MeshToonMaterial` s `side: FrontSide` odřízl
    // jako odvrácenou — vada, kterou počet trojúhelníků neuvidí.
    const geometry = compileGeomProgram(
      program(
        [
          { kind: 'mass', variant: 'block', at: [3, 0, 0] },
          { kind: 'mirror', child: 0, axis: 'x' },
        ],
        1,
      ),
    );
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const stored = new Vector3();

    for (let triangle = 0; triangle < position.count; triangle += 3) {
      a.fromBufferAttribute(position, triangle);
      b.fromBufferAttribute(position, triangle + 1);
      c.fromBufferAttribute(position, triangle + 2);
      stored.fromBufferAttribute(normal, triangle);
      const geometric = b.clone().sub(a).cross(c.clone().sub(a));
      if (geometric.lengthSq() === 0) continue;

      expect(geometric.normalize().dot(stored)).toBeGreaterThan(0);
    }
  });

  it('carve odebere trojúhelníky uvnitř kvádru a okolí nechá', () => {
    const wall = program(
      [
        { kind: 'panel', variant: 'wall' },
        { kind: 'repeat', child: 0, count: 5, step: [1, 0, 0] },
      ],
      1,
    );
    const carved = program(
      [...wall.nodes, { kind: 'carve', child: 1, at: [2, 0, 0], size: [1.2, 4, 4] }],
      2,
    );

    const before = trianglesOf(wall);
    const after = trianglesOf(carved);

    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  it('carve mimo těleso neubere nic', () => {
    const wall: GeomProgram['nodes'] = [{ kind: 'panel', variant: 'wall' }];

    expect(trianglesOf(program([...wall, { kind: 'carve', child: 0, at: [40, 0, 0], size: [2, 2, 2] }], 1))).toBe(
      trianglesOf(program(wall, 0)),
    );
  });

  it('program, ze kterého carve nenechá nic, se odmítne s důvodem', () => {
    expect(() =>
      compileGeomProgram(
        program(
          [
            { kind: 'mass', variant: 'block' },
            { kind: 'carve', child: 0, at: [0, 0, 0], size: [64, 64, 64] },
          ],
          1,
        ),
      ),
    ).toThrow(/compiled to an empty geometry/);
  });

  it('group slepí větve, nenahradí je první z nich', () => {
    const parts = trianglesOf(program([{ kind: 'mass', variant: 'block' }], 0)) +
      trianglesOf(program([{ kind: 'organic', variant: 'tree' }], 0));
    const grouped = trianglesOf(
      program(
        [
          { kind: 'mass', variant: 'block' },
          { kind: 'organic', variant: 'tree', at: [4, 0, 0] },
          { kind: 'group', children: [0, 1] },
        ],
        2,
      ),
    );

    expect(grouped).toBe(parts);
  });
});

describe('terén je zem, ne deska', () => {
  const heights = (doc: GeomProgram) => {
    const position = compileGeomProgram(doc).getAttribute('position');
    return Array.from({ length: position.count }, (_unused, index) => position.getY(index));
  };

  it('rovina s nulovou amplitudou je vodorovná', () => {
    const y = heights(program([{ kind: 'terrain', variant: 'flat', extent: [20, 20], amplitude: 0, seed: 3 }], 0));

    expect(new Set(y.map((value) => Math.round(value * 1e5)))).toEqual(new Set([0]));
  });

  it('rovina zůstane rovná i s amplitudou — zvlní ji jen nerovnost ze semínka', () => {
    // Nulová amplituda je rovná u každé varianty, takže sama o sobě
    // o `flat` nedokazuje nic. Tenhle případ ano: reliéf je 0, zbyde jen
    // nerovnost, která je 15 % amplitudy.
    const amplitude = 4;
    const y = heights(program([{ kind: 'terrain', variant: 'flat', extent: [20, 20], amplitude, seed: 3 }], 0));

    expect(Math.max(...y.map(Math.abs))).toBeLessThanOrEqual((amplitude * 0.15) / 2);
  });

  it('hřeben má výšku a drží se pod amplitudou', () => {
    const y = heights(program([{ kind: 'terrain', variant: 'ridge', extent: [24, 24], amplitude: 4, seed: 3 }], 0));

    expect(Math.max(...y) - Math.min(...y)).toBeGreaterThan(1);
    expect(Math.max(...y)).toBeLessThanOrEqual(4.5);
  });

  it('sousední trojúhelníky sdílejí výšku rohu, takže v zemi není trhlina', () => {
    // Nerovnost ze semínka se musí počítat jednou do mřížky. Kdyby se losovala
    // na trojúhelník, dva sousedi by v témž rohu seděli jinde.
    const position = compileGeomProgram(
      program([{ kind: 'terrain', variant: 'basin', extent: [12, 12], amplitude: 3, seed: 4 }], 0),
    ).getAttribute('position');
    const byColumn = new Map<string, Set<number>>();

    for (let index = 0; index < position.count; index += 1) {
      const key = `${Math.round(position.getX(index) * 1e4)},${Math.round(position.getZ(index) * 1e4)}`;
      const bucket = byColumn.get(key) ?? new Set<number>();
      bucket.add(Math.round(position.getY(index) * 1e4));
      byColumn.set(key, bucket);
    }

    expect([...byColumn.values()].filter((bucket) => bucket.size > 1)).toEqual([]);
  });
});


/**
 * Uzel `sweep` z P14 T10 — jediná zakřivená forma, kterou jazyk umí sám.
 *
 * **Proč se tady měří tvar a ne počet.** Tažení profilu po křivce umí vyrobit
 * těleso, které má správný počet trojúhelníků, drží rozpočet a přitom je
 * děravé, obrácené naruby nebo zkroucené kolem vlastní osy. Test na počet
 * trojúhelníků by všechny tři vady propustil, takže se tu počítají **hrany**
 * (uzavřenost) a **znaménko objemu** (orientace).
 */
describe('profil tažený po křivce je uzavřené těleso', () => {
  const SQUARE: [number, number][] = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];

  const sweep = (patch: Record<string, unknown> = {}) =>
    sweepGeometry({
      kind: 'sweep',
      profile: SQUARE,
      path: [
        [-3, 0, 0],
        [0, 4, 0],
        [3, 0, 0],
      ],
      segments: 12,
      swatch: 'shell',
      ...patch,
    } as Extract<GeomNode, { kind: 'sweep' }>);

  const positionsOf = (geometry: BufferGeometry) =>
    geometry.getAttribute('position').array as Float32Array;

  /** Klíč vrcholu. Zaokrouhlení je nutné: sousední trojúhelníky počítají týž
   *  roh dvěma cestami a ve `Float32Array` se rozejdou v poslední číslici. */
  const key = (position: Float32Array, at: number) =>
    [position[at], position[at + 1], position[at + 2]]
      .map((value) => Math.round(value * 1e5) / 1e5)
      .join(',');

  /** Každou orientovanou hranu spočítá zvlášť. */
  function edgeCensus(geometry: BufferGeometry): Map<string, number> {
    const position = positionsOf(geometry);
    const edges = new Map<string, number>();

    for (let triangle = 0; triangle < position.length; triangle += 9) {
      const corners = [0, 3, 6].map((offset) => key(position, triangle + offset));
      for (let corner = 0; corner < 3; corner += 1) {
        const edge = `${corners[corner]}->${corners[(corner + 1) % 3]}`;
        edges.set(edge, (edges.get(edge) ?? 0) + 1);
      }
    }

    return edges;
  }

  /** Objem přes divergenční větu. Kladný = vinutí ven, záporný = naruby. */
  function signedVolume(geometry: BufferGeometry): number {
    const position = positionsOf(geometry);
    let volume = 0;

    for (let triangle = 0; triangle < position.length; triangle += 9) {
      const a = new Vector3(position[triangle], position[triangle + 1], position[triangle + 2]);
      const b = new Vector3(position[triangle + 3], position[triangle + 4], position[triangle + 5]);
      const c = new Vector3(position[triangle + 6], position[triangle + 7], position[triangle + 8]);
      volume += a.dot(new Vector3().crossVectors(b, c)) / 6;
    }

    return volume;
  }

  it('každá hrana patří přesně dvěma trojúhelníkům, a to opačně orientovaným', () => {
    const edges = edgeCensus(sweep());

    // Každá orientovaná hrana právě jednou = souvislá orientace bez překrytí.
    expect([...edges.values()].filter((count) => count !== 1)).toEqual([]);

    // A ke každé musí existovat opačná = v plášti ani ve víkách není díra.
    const missing = [...edges.keys()].filter((edge) => {
      const [from, to] = edge.split('->');
      return !edges.has(`${to}->${from}`);
    });
    expect(missing).toEqual([]);
  });

  it('normály míří ven, i když model napíše profil obráceně', () => {
    // Znaménko objemu je jediná levná kontrola orientace celého tělesa.
    // Druhá polovina je ta podstatná: profil po směru hodinových ručiček si
    // kompilátor otočí sám, takže se model nemusí trefit do konvence, o které
    // se nikde nedozví.
    expect(signedVolume(sweep())).toBeGreaterThan(0);
    expect(signedVolume(sweep({ profile: [...SQUARE].reverse() }))).toBeGreaterThan(0);
  });

  it('obrácený profil dá tytéž vrcholy, jen jinak zapsané', () => {
    expect(signedVolume(sweep({ profile: [...SQUARE].reverse() }))).toBeCloseTo(
      signedVolume(sweep()),
      6,
    );
  });

  it('počet trojúhelníků sedí na vzorec plášť + víka', () => {
    for (const segments of [2, 7, 12, MAX_SWEEP_SEGMENTS]) {
      const triangles = trianglesOfGeometry(sweep({ segments }));

      expect(triangles, `${segments} dílků`).toBe(segments * SQUARE.length * 2 + 2 * (SQUARE.length - 2));
    }
  });

  it('nejdražší povolený sweep drží rozpočet jednoho kusu', () => {
    const widest = Array.from({ length: MAX_CURVE_POINTS }, (_unused, index) => {
      const angle = (index / MAX_CURVE_POINTS) * Math.PI * 2;
      return [Math.cos(angle), Math.sin(angle)] as [number, number];
    });

    const triangles = trianglesOfGeometry(
      sweep({ profile: widest, segments: MAX_SWEEP_SEGMENTS }),
    );

    expect(triangles).toBeLessThanOrEqual(KIT_BUDGETS.maxTrianglesPerPiece);
  });

  it('oblouk má jiný obal než týž profil bez tažení', () => {
    // AC úlohy. Kdyby se dráha ignorovala a profil se jen protáhl mezi konci,
    // vyšly by oba obaly stejné — a všechno ostatní by prošlo.
    const arch = sweep();
    const straight = sweep({
      path: [
        [-3, 0, 0],
        [3, 0, 0],
      ],
    });

    arch.computeBoundingBox();
    straight.computeBoundingBox();

    expect(arch.boundingBox).not.toBeNull();
    expect(straight.boundingBox).not.toBeNull();
    expect(arch.boundingBox?.max.y).toBeGreaterThan((straight.boundingBox?.max.y ?? 0) + 1);
    expect(arch.boundingBox?.equals(straight.boundingBox!)).toBe(false);
  });

  it('svislá dráha rám nepřevrátí — proto se přenáší, ne staví z osy nahoru', () => {
    // Přesně ta dráha, na které by Gram-Schmidt proti světové svislici
    // degeneroval: tečna je s ní rovnoběžná. Klenba je zrovna tenhle případ.
    const vertical = sweep({
      path: [
        [0, 0, 0],
        [0, 3, 0],
        [0, 6, 0],
      ],
    });

    expect([...edgeCensus(vertical).values()].filter((count) => count !== 1)).toEqual([]);
    expect(signedVolume(vertical)).toBeGreaterThan(0);
    expect([...positionsOf(vertical)].every(Number.isFinite)).toBe(true);
  });

  it('normály jsou zapečené ploché, tedy totéž co computeVertexNormals nad nezaindexovanou sítí', () => {
    // `MeshToonMaterial` nemá `flatShading`, takže ploché normály musí být
    // v geometrii. Druhá implementace téhož výpočtu by byla druhá pravda —
    // tenhle test drží obě cesty na sobě.
    const geometry = sweep();
    const reference = new BufferGeometry();
    reference.setAttribute('position', new BufferAttribute(positionsOf(geometry).slice(), 3));
    reference.computeVertexNormals();

    const ours = geometry.getAttribute('normal').array as Float32Array;
    const theirs = reference.getAttribute('normal').array as Float32Array;

    expect(ours.length).toBe(theirs.length);
    for (let index = 0; index < ours.length; index += 1) {
      expect(ours[index]).toBeCloseTo(theirs[index], 5);
    }
  });

  it('vrcholy nesou odstín kitu, takže je paleta umí přebarvit', () => {
    for (const swatch of SWATCH_NAMES) {
      expect(() => repaint(sweep({ swatch }), PALETTES.harbor), swatch).not.toThrow();
    }
  });

  it('dvojí tažení téhož uzlu dá bajt po bajtu totéž', () => {
    // Uzel nesahá na PRNG vůbec, takže tohle není o semínku — je to o tom, že
    // se do výpočtu nedostal ani čas, ani pořadí iterace mapy.
    expect([...positionsOf(sweep())]).toEqual([...positionsOf(sweep())]);
  });

  it('program se sweepem projde celým kompilátorem, ne jen generátorem', () => {
    const geometry = compileGeomProgram({
      version: GEOM_VERSION,
      nodes: [
        {
          kind: 'sweep',
          profile: SQUARE,
          path: [
            [-3, 0, 0],
            [0, 4, 0],
            [3, 0, 0],
          ],
          segments: 10,
          swatch: 'accent',
          at: [0, 1, 0],
          scale: [1, 1, 2],
        },
      ],
      root: 0,
    });

    expect(trianglesOfGeometry(geometry)).toBeGreaterThan(0);
    expect(() => repaint(geometry, PALETTES.frost)).not.toThrow();
  });
});

describe('dvacet programů se vejde do rozpočtu kitu', () => {
  const measured = BUDGET_PROGRAMS.map(([id, doc]) => {
    const started = performance.now();
    const geometry = compileGeomProgram(doc);
    const milliseconds = performance.now() - started;
    const entry = {
      id,
      pieces: instanceCounts(doc.nodes)[doc.root],
      triangles: trianglesOfGeometry(geometry),
      milliseconds,
    };
    geometry.dispose();
    return entry;
  });

  it('měří se jich dvacet, ne kolik zrovna vyjde', () => {
    expect(measured).toHaveLength(20);
    expect(new Set(measured.map((entry) => entry.id)).size).toBe(20);
  });

  it.each(measured.map((entry) => [entry.id, entry] as const))(
    '%s je pod stropem kusů i trojúhelníků',
    (_id, entry) => {
      expect(entry.pieces).toBeLessThanOrEqual(KIT_BUDGETS.maxDrawCallsPerWorld);
      expect(entry.triangles).toBeLessThanOrEqual(KIT_BUDGETS.maxTrianglesPerWorld);
      expect(entry.triangles).toBeGreaterThan(0);
    },
  );

  it('žádný program se nepřekládá déle než 120 ms', () => {
    // Seznam, ne jen maximum — při pádu je vidět, který program to je.
    const over = measured
      .filter((entry) => entry.milliseconds >= 120)
      .map((entry) => `${entry.id}: ${entry.milliseconds.toFixed(1)} ms`);

    expect(over).toEqual([]);
  });

  // `scripts/prove-budgets.mjs` si artefakt vyžádá proměnnou a pak si čísla
  // přepočítá sám. Bez proměnné se nic nezapisuje, aby `npm test` neplivalo
  // soubory do stromu.
  it.skipIf(process.env.GEOM_BUDGET_ARTIFACT === undefined)('zapíše naměřená čísla pro skript', () => {
    const path = resolve(process.cwd(), process.env.GEOM_BUDGET_ARTIFACT!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          caps: {
            maxPieces: KIT_BUDGETS.maxDrawCallsPerWorld,
            maxTriangles: KIT_BUDGETS.maxTrianglesPerWorld,
            maxCompileMilliseconds: 120,
          },
          programs: measured.map(({ id, pieces, triangles, milliseconds }) => ({
            id,
            pieces,
            triangles,
            milliseconds: Number(milliseconds.toFixed(3)),
          })),
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    expect(GEOM_LIMITS.maxInstances).toBe(KIT_BUDGETS.maxDrawCallsPerWorld);
  });
});

/**
 * P13 vlna 1 T6 — volné otáčení musí být nadmnožina, ne náhrada.
 *
 * Kdyby se jednotka změnila z čtvrtin otáčky na radiány, znamenal by zápis
 * `yaw: 1` v každém dosavadním programu i v každém zmrazeném měření najednou
 * 57° místo 90° — a nic by nezčervenalo, protože obojí je platné číslo.
 * Tenhle test je jediné místo, kde se to pozná.
 */
describe('volné otáčení sedí na kvadrantech bit po bitu', () => {
  const quarterTurnMatrix = (turns: number): readonly number[] => [
    ...new Matrix4()
      .compose(
        new Vector3(1.5, 2, -3),
        new Quaternion().setFromEuler(new Euler(0, (turns * Math.PI) / 2, 0)),
        new Vector3(2, 0.5, 1.25),
      )
      .elements,
  ];

  it.each([0, 1, 2, 3])('yaw %i dá tutéž matici jako před rozšířením', (turns) => {
    const now = placementMatrix([1.5, 2, -3], { yaw: turns }, [2, 0.5, 1.25]);

    expect([...now.elements]).toEqual(quarterTurnMatrix(turns));
  });

  it('nenapsaný pitch a roll se chovají jako nula, ne jako chybějící osa', () => {
    const implicit = placementMatrix([1.5, 2, -3], { yaw: 1 }, [2, 0.5, 1.25]);
    const explicit = placementMatrix([1.5, 2, -3], { yaw: 1, pitch: 0, roll: 0 }, [2, 0.5, 1.25]);

    expect([...implicit.elements]).toEqual([...explicit.elements]);
  });

  it('zlomkový úhel dá jinou matici, takže se doopravdy otáčí volně', () => {
    const fractional = placementMatrix([1.5, 2, -3], { yaw: 0.37 }, [2, 0.5, 1.25]);

    expect([...fractional.elements]).not.toEqual(quarterTurnMatrix(0));
  });
});

/* ------------------------------------------------------------------ *
 * Kotvy: sedm míst na kvádru, každé proti ručně spočítanému bodu.
 * ------------------------------------------------------------------ */

describe('anchorPointOf – každé místo zvlášť', () => {
  /**
   * Nález nezávislého review: šest ze sedmi míst kotvy neprocházel žádný test
   * a to sedmé (`top`) se ověřovalo porovnáním `compilePlacements` proti
   * `compileGeomProgram`. Obě cesty volají **tutéž** `anchorTranslation`, takže
   * prohozené `box.min.y` / `box.max.y` nebo `north` ↔ `south` posune obě
   * stejně a zůstane zeleno. Očekávané body jsou proto **napsané ručně**, ne
   * dopočítané toutéž úvahou — týž postup, jaký `placement.test.ts` používá
   * pro `placementMatrix`.
   *
   * Kvádr je schválně nesouměrný a mimo počátek: na krychli v počátku by se
   * `min` a `max` lišily jen znaménkem a půlka záměn by se schovala.
   */
  const box = new Box3(new Vector3(-3, 1, -8), new Vector3(5, 7, 2));
  // Střed: x = (−3+5)/2 = 1, y = (1+7)/2 = 4, z = (−8+2)/2 = −3.
  const cases: Array<[AnchorSite, [number, number, number]]> = [
    ['top', [1, 7, -3]],
    ['bottom', [1, 1, -3]],
    ['north', [1, 4, -8]],
    ['south', [1, 4, 2]],
    ['east', [5, 4, -3]],
    ['west', [-3, 4, -3]],
    ['center', [1, 4, -3]],
  ];

  for (const [site, expected] of cases) {
    it(`${site} sedí na ručně spočítaném bodě`, () => {
      const point = anchorPointOf(box, site);
      expect([point.x, point.y, point.z], `kotva ${site} je jinde`).toEqual(expected);
    });
  }

  it('sedm míst dá sedm různých bodů', () => {
    // Kdyby dvě větve `switch` spadly na tutéž (třeba přes `default`), tabulka
    // výš by to ukázala jen u toho místa, které se zkopírovalo — tohle to
    // ukáže vždycky.
    const points = ANCHOR_SITES.map((site) => anchorPointOf(box, site).toArray().join(','));
    expect(new Set(points).size).toBe(ANCHOR_SITES.length);
  });

  it('`anchorTo` na prázdný podstrom se jmenuje, ne posune o nekonečno', () => {
    // `Box3` prázdné geometrie má `min` na +Infinity; bez téhle výjimky by
    // z toho vznikl posun o nekonečno a kus by z obrazu zmizel beze stopy.
    expect(() => boundsOfGeometry(new BufferGeometry())).toThrow(
      /no geometry to anchor against/,
    );
  });
});
