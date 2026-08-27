import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { KIT_BUDGETS, PALETTES, repaint } from '@/kit';
import { compileGeomProgram, trianglesOfGeometry } from '../compile';
import { GEOM_LIMITS, GEOM_VERSION, instanceCounts, type GeomProgram } from '../program';

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
