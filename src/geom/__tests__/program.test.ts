import { describe, expect, it } from 'vitest';

import { KIT, KIT_BUDGETS } from '@/kit';
import {
  GEOM_LIMITS,
  GEOM_VERSION,
  OPERATION_KINDS,
  PIECE_VARIANTS,
  SHAPE_KINDS,
  childIndicesOf,
  instanceCounts,
  parseGeomProgram,
  pieceIdOf,
  validateGeomProgram,
  type GeomNode,
  type GeomProgram,
  type PieceKind,
} from '../program';

/**
 * Program, ve kterém je **každý** druh uzlu aspoň jednou. Slouží dvakrát: jako
 * doklad, že se slovník dá poskládat do jednoho světa, a jako základ, ze
 * kterého si zamítavé testy dělají porouchané kopie.
 */
function coveringProgram(): GeomProgram {
  return {
    version: GEOM_VERSION,
    nodes: [
      { kind: 'terrain', variant: 'ridge', extent: [24, 24], amplitude: 2.5, seed: 11 },
      { kind: 'mass', variant: 'block', at: [0, 0, 0] },
      { kind: 'repeat', child: 1, count: 4, step: [2, 0, 0] },
      { kind: 'mirror', child: 2, axis: 'x' },
      { kind: 'column', variant: 'pillar', scale: [1, 1.6, 1] },
      { kind: 'scatter', child: 4, count: 6, radius: 5, seed: 12 },
      { kind: 'panel', variant: 'wall', at: [0, 0, -4], yaw: 1 },
      { kind: 'carve', child: 6, at: [0, 0.5, -4], size: [1.2, 1.8, 2] },
      { kind: 'arch', variant: 'doorway', at: [0, 0, -4] },
      { kind: 'organic', variant: 'tree', at: [6, 0, 6] },
      { kind: 'group', children: [0, 3, 5, 7, 8, 9] },
    ],
    root: 10,
  };
}

/** Kopie programu s jednou vadou. Struktura se nesmí sdílet mezi testy. */
function broken(mutate: (program: GeomProgram) => void): unknown {
  const copy = structuredClone(coveringProgram()) as GeomProgram;
  mutate(copy);
  return copy;
}

describe('slovník programu je slovník kitu', () => {
  it.each(Object.keys(PIECE_VARIANTS) as PieceKind[])(
    '%s vyjmenovává přesně kusy své kategorie z KIT',
    (kind) => {
      const fromKit = KIT.filter((piece) => piece.category === kind).map((piece) =>
        piece.id.slice(kind.length + 1),
      );

      expect([...PIECE_VARIANTS[kind]]).toEqual(fromKit);
    },
  );

  it('každá varianta programu se v KIT najde pod svým id', () => {
    for (const kind of Object.keys(PIECE_VARIANTS) as PieceKind[]) {
      for (const variant of PIECE_VARIANTS[kind]) {
        expect(KIT.some((piece) => piece.id === pieceIdOf(kind, variant))).toBe(true);
      }
    }
  });

  it('kit nemá kategorii, o které by program nevěděl — kromě fixture a actor', () => {
    // `fixture` a `actor` vkládá simulace, ne výtvarný program. Nová kategorie
    // v kitu se tímhle testem ohlásí místo aby tiše zmizela z emise.
    const known = new Set<string>([...Object.keys(PIECE_VARIANTS), 'fixture', 'actor']);
    const categories = [...new Set(KIT.map((piece) => piece.category))];

    expect(categories.filter((category) => !known.has(category))).toEqual([]);
  });

  it('terrain je jediný tvar bez kusu v kitu', () => {
    const withoutPiece = SHAPE_KINDS.filter((kind) => !(kind in PIECE_VARIANTS));

    expect(withoutPiece).toEqual(['terrain']);
  });
});

describe('stropy programu nejsou druhý rozpočet', () => {
  it('maxInstances je maxDrawCallsPerWorld z kitu', () => {
    // Jeden umístěný kus = jeden draw call. Kdyby se čísla rozešla, program by
    // směl vyrobit svět, který kit sám za rozpočtový považovat nesmí.
    expect(GEOM_LIMITS.maxInstances).toBe(KIT_BUDGETS.maxDrawCallsPerWorld);
  });
});

describe('platný program projde', () => {
  it('program se všemi druhy uzlů je přijatý', () => {
    expect(validateGeomProgram(coveringProgram())).toEqual({ ok: true, issues: [] });
  });

  it('v pokrývajícím programu je opravdu každý druh uzlu', () => {
    const used = new Set(coveringProgram().nodes.map((node) => node.kind));

    expect([...SHAPE_KINDS, ...OPERATION_KINDS].filter((kind) => !used.has(kind))).toEqual([]);
  });

  it('parseGeomProgram vrátí týž dokument', () => {
    expect(parseGeomProgram(coveringProgram())).toEqual(coveringProgram());
  });

  it('nejmenší možný program je jeden tvar', () => {
    const single = { version: GEOM_VERSION, nodes: [{ kind: 'mass', variant: 'block' }], root: 0 };

    expect(validateGeomProgram(single).ok).toBe(true);
  });
});

describe('rozvinutí operací se počítá, ne odhaduje', () => {
  it('repeat, mirror a scatter násobí, carve nechává být, group sčítá', () => {
    const counts = instanceCounts(coveringProgram().nodes);

    expect(counts[0]).toBe(1); // terrain
    expect(counts[2]).toBe(4); // repeat 4 nad jedním kusem
    expect(counts[3]).toBe(8); // mirror zdvojí
    expect(counts[5]).toBe(6); // scatter 6
    expect(counts[7]).toBe(1); // carve nepřidá ani neubere
    expect(counts[10]).toBe(1 + 8 + 6 + 1 + 1 + 1);
  });

  it('vnořené operace se násobí, ne sčítají', () => {
    const nested: GeomProgram = {
      version: GEOM_VERSION,
      nodes: [
        { kind: 'mass', variant: 'block' },
        { kind: 'repeat', child: 0, count: 5, step: [1, 0, 0] },
        { kind: 'repeat', child: 1, count: 4, step: [0, 0, 1] },
      ],
      root: 2,
    };

    expect(instanceCounts(nested.nodes)[2]).toBe(20);
  });

  it('childIndicesOf vidí všechny potomky group, ne jen prvního', () => {
    const group = coveringProgram().nodes[10];

    expect(childIndicesOf(group)).toEqual([0, 3, 5, 7, 8, 9]);
  });

  it('tvarový uzel nemá potomky', () => {
    expect(childIndicesOf(coveringProgram().nodes[1])).toEqual([]);
  });
});

describe('vadný program se odmítne a řekne proč', () => {
  const rejects = (input: unknown, matcher: RegExp) => {
    const result = validateGeomProgram(input);

    expect(result.ok).toBe(false);
    expect(result.issues.join(' | ')).toMatch(matcher);
  };

  it('tabulka nad stropem uzlů', () => {
    const nodes: GeomNode[] = Array.from({ length: GEOM_LIMITS.maxNodes + 1 }, () => ({
      kind: 'mass',
      variant: 'block',
    }));

    rejects({ version: GEOM_VERSION, nodes, root: 0 }, /schema:\/nodes/);
  });

  it('prázdná tabulka', () => {
    rejects({ version: GEOM_VERSION, nodes: [], root: 0 }, /schema:\/nodes/);
  });

  it('neznámá varianta kusu', () => {
    rejects(
      broken((program) => {
        (program.nodes[1] as { variant: string }).variant = 'skyscraper';
      }),
      /schema:\/nodes\/1\/variant/,
    );
  });

  it('neznámý druh uzlu', () => {
    rejects(
      broken((program) => {
        (program.nodes[1] as { kind: string }).kind = 'sculpture';
      }),
      /schema:\/nodes\/1/,
    );
  });

  it('cizí klíč navíc', () => {
    rejects(
      broken((program) => {
        (program.nodes[1] as Record<string, unknown>).material = 'chrome';
      }),
      /schema:\/nodes\/1/,
    );
  });

  it('špatná verze mezijazyka', () => {
    rejects(
      broken((program) => {
        (program as { version: string }).version = 'geom-program-v2';
      }),
      /schema:\/version/,
    );
  });

  it.each([
    ['souřadnice mimo rozsah', (p: GeomProgram) => void (p.nodes[1] = { kind: 'mass', variant: 'block', at: [900, 0, 0] })],
    ['nulové měřítko', (p: GeomProgram) => void (p.nodes[1] = { kind: 'mass', variant: 'block', scale: [0, 1, 1] })],
    ['yaw mimo čtvrtiny', (p: GeomProgram) => void (p.nodes[1] = { kind: 'mass', variant: 'block', yaw: 4 })],
    ['repeat s jedinou kopií', (p: GeomProgram) => void ((p.nodes[2] as { count: number }).count = 1)],
    ['repeat nad stropem', (p: GeomProgram) => void ((p.nodes[2] as { count: number }).count = 17)],
    ['zlomkový počet kopií', (p: GeomProgram) => void ((p.nodes[2] as { count: number }).count = 3.5)],
    ['scatter s nulovým poloměrem', (p: GeomProgram) => void ((p.nodes[5] as { radius: number }).radius = 0)],
    ['záporné semínko', (p: GeomProgram) => void ((p.nodes[5] as { seed: number }).seed = -1)],
    ['nekonečná amplituda terénu', (p: GeomProgram) => void ((p.nodes[0] as { amplitude: number }).amplitude = Number.POSITIVE_INFINITY)],
    ['NaN v kroku', (p: GeomProgram) => void ((p.nodes[2] as { step: number[] }).step = [Number.NaN, 0, 0])],
    ['osa y u zrcadla', (p: GeomProgram) => void ((p.nodes[3] as { axis: string }).axis = 'y')],
    ['nulový řez', (p: GeomProgram) => void ((p.nodes[7] as { size: number[] }).size = [0, 1, 1])],
    ['group bez potomků', (p: GeomProgram) => void ((p.nodes[10] as { children: number[] }).children = [])],
  ])('ohraničený parametr: %s', (_label, mutate) => {
    rejects(broken(mutate), /schema:\/nodes\//);
  });

  it('potomek na sebe nebo nad sebe', () => {
    rejects(
      broken((program) => {
        (program.nodes[2] as { child: number }).child = 2;
      }),
      /node 2 references node 2 at or above itself/,
    );
  });

  it('potomek pod kořenem, ale nad rodičem', () => {
    rejects(
      broken((program) => {
        (program.nodes[3] as { child: number }).child = 9;
      }),
      /node 3 references node 9 at or above itself/,
    );
  });

  it('group ukazuje na uzel nad sebou', () => {
    rejects(
      broken((program) => {
        program.nodes[7] = { kind: 'group', children: [6, 8] };
      }),
      /node 7 references node 8 at or above itself/,
    );
  });

  it('kořen mimo tabulku', () => {
    rejects(
      broken((program) => {
        (program as { root: number }).root = 40;
      }),
      /root references node 40 outside the table of 11/,
    );
  });

  it('program, který se po rozvinutí nevejde do rozpočtu kusů', () => {
    // Dva řádky, 384 kusů. Přesně ten případ, na který strop uzlů nestačí.
    const explosive = {
      version: GEOM_VERSION,
      nodes: [
        { kind: 'mass', variant: 'block' },
        { kind: 'repeat', child: 0, count: 16, step: [1, 0, 0] },
        { kind: 'scatter', child: 1, count: 24, radius: 20, seed: 1 },
      ],
      root: 2,
    };

    rejects(explosive, /expands to 384 placed pieces, above maxInstances 120/);
  });

  it('program přesně na stropu kusů projde', () => {
    const atLimit = {
      version: GEOM_VERSION,
      nodes: [
        { kind: 'mass', variant: 'block' },
        { kind: 'repeat', child: 0, count: 15, step: [1, 0, 0] },
        { kind: 'scatter', child: 1, count: 8, radius: 20, seed: 1 },
      ],
      root: 2,
    };

    expect(instanceCounts(parseGeomProgram(atLimit).nodes)[2]).toBe(GEOM_LIMITS.maxInstances);
  });

  it('nálezů se vrací víc než jeden, ne první', () => {
    const result = validateGeomProgram(
      broken((program) => {
        (program.nodes[2] as { child: number }).child = 2;
        (program.nodes[3] as { child: number }).child = 3;
      }),
    );

    expect(result.issues.length).toBe(2);
  });

  it('parseGeomProgram vyhodí s důvodem uvnitř zprávy', () => {
    expect(() =>
      parseGeomProgram(
        broken((program) => {
          (program as { root: number }).root = 40;
        }),
      ),
    ).toThrow(/invalid geom program: root references node 40/);
  });
});
