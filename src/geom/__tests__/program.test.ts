import { describe, expect, it } from 'vitest';

import { KIT, KIT_BUDGETS, SWATCHES } from '@/kit';
import {
  GEOM_LIMITS,
  GEOM_VERSION,
  MAX_CURVE_POINTS,
  MAX_SWEEP_SEGMENTS,
  OPERATION_KINDS,
  PIECE_VARIANTS,
  SHAPE_KINDS,
  SWATCH_NAMES,
  childIndicesOf,
  instanceCounts,
  parseGeomProgram,
  pieceIdOf,
  profileArea,
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

      // P13 vlna 1 T6. Připsané **za** dosavadní skupinu, ne doprostřed:
      // zamítavé testy níž si na uzly sahají indexem, a posunutá tabulka by
      // z nich udělala testy něčeho jiného, aniž by zčervenaly.
      { kind: 'arrayAlongCurve', child: 8, count: 5, points: [[0, 0, 0], [4, 0, 3], [8, 0, 0]] },
      { kind: 'anchorTo', child: 9, target: 1, site: 'top' },
      { kind: 'group', children: [10, 11, 12] },

      // P14 T4. Zase **za** dosavadní tabulku, ze stejného důvodu jako výš:
      // zamítavé testy sahají na uzly indexem. Délku tabulky proto žádný test
      // neopisuje číslem — čte ji z tohohle programu.
      { kind: 'fixture', variant: 'crate', at: [3, 0, 3] },
      { kind: 'actor', variant: 'tall', at: [2, 0, 2] },
      { kind: 'group', children: [13, 14, 15] },

      // P14 T10. Zase **za** dosavadní tabulku, ze stejného důvodu jako výš.
      // Kořen se tím posouvá z 16 na 18 — žádný test ho neopisuje číslem,
      // čtou ho z tohohle programu.
      {
        kind: 'sweep',
        profile: [
          [-0.4, -0.4],
          [0.4, -0.4],
          [0.4, 0.4],
          [-0.4, 0.4],
        ],
        path: [
          [0, 0, 0],
          [0, 3, 2],
          [0, 0, 4],
        ],
        segments: 12,
        swatch: 'shell',
        at: [-6, 0, 0],
      },
      { kind: 'group', children: [16, 17] },
    ],
    root: 18,
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

  it('kit nemá kategorii, o které by program nevěděl', () => {
    // Do P14 T4 tu stála výjimka pro `fixture` a `actor`. Padla s nimi:
    // program teď umí každou kategorii, kterou kit vydává, a nová kategorie
    // se tímhle testem ohlásí místo aby tiše zmizela z emise.
    const known = new Set<string>(Object.keys(PIECE_VARIANTS));
    const categories = [...new Set(KIT.map((piece) => piece.category))];

    expect(categories.filter((category) => !known.has(category))).toEqual([]);
  });

  it('každý kus kitu je z programu dosažitelný', () => {
    // **Tohle je ta vada, kterou oko nechytí.** Dvanáct kusů (osm `fixture`,
    // čtyři `actor`) leželo v kitu celé týdny a žádný program je neuměl
    // postavit — testy výš se ptaly jen na to, jestli sedí varianty kategorií,
    // které program **zná**, takže o chybějící kategorii mlčely.
    //
    // Aserce jde přes celý `KIT`, ne přes `PIECE_VARIANTS`: kdyby se ptala
    // z mapy, měřila by mapu proti sobě samé.
    const reachable = new Set<string>(
      (Object.keys(PIECE_VARIANTS) as PieceKind[]).flatMap((kind) =>
        PIECE_VARIANTS[kind].map((variant) => pieceIdOf(kind, variant)),
      ),
    );

    expect(KIT.filter((piece) => !reachable.has(piece.id)).map((piece) => piece.id)).toEqual([]);
    expect(reachable.size, 'kit má 42 kusů a všechny musí být dosažitelné').toBe(KIT.length);
  });

  it('generované tvary bez kusu v kitu jsou právě terrain a sweep', () => {
    // Do P14 T10 tu stál jen `terrain`. `sweep` přibyl a je to druhý tvar
    // téhož druhu: kus kitu se dá otočit a zvětšit, ale ne ohnout, takže
    // klenba se z něj složit nedá a musí se spočítat. **Seznam je uzavřený
    // schválně** — třetí generovaný tvar znamená třetí generátor sítí a ten
    // má někdo obhájit, ne ho přidat mimochodem.
    const withoutPiece = SHAPE_KINDS.filter((kind) => !(kind in PIECE_VARIANTS));

    expect(withoutPiece).toEqual(['terrain', 'sweep']);
  });
});


describe('profil tažený po křivce má meze, které nejsou nové', () => {
  const sweepNode = (patch: Record<string, unknown> = {}): GeomNode =>
    ({
      kind: 'sweep',
      profile: [
        [-0.5, -0.5],
        [0.5, -0.5],
        [0.5, 0.5],
        [-0.5, 0.5],
      ],
      path: [
        [0, 0, 0],
        [0, 2, 2],
        [0, 0, 4],
      ],
      segments: 8,
      swatch: 'deep',
      ...patch,
    }) as GeomNode;

  const sweepProgram = (patch: Record<string, unknown> = {}): unknown => ({
    version: GEOM_VERSION,
    nodes: [sweepNode(patch)],
    root: 0,
  });

  it('odstíny sweepu jsou přesně odstíny kitu', () => {
    // Opsaný seznam v `program.ts` proti skutečnému kitu. Kdyby se rozešly,
    // model by mohl emitovat odstín, na kterém `repaint()` vyhodí — nebo by
    // mu naopak zmizel odstín, který kit vydává.
    expect([...SWATCH_NAMES]).toEqual(Object.keys(SWATCHES));
  });

  it('dráha sdílí strop bodů s arrayAlongCurve, nemá vlastní', () => {
    const points = (count: number) =>
      Array.from({ length: count }, (_unused, index) => [index, 0, index] as const);

    // Obojí na tomtéž čísle: jeden uzel jazyka ve dvou větvích nesmí mít dvě
    // meze, protože pak platí ta menší a druhá je dekorace.
    expect(validateGeomProgram(sweepProgram({ path: points(MAX_CURVE_POINTS) })).ok).toBe(true);
    expect(validateGeomProgram(sweepProgram({ path: points(MAX_CURVE_POINTS + 1) })).ok).toBe(false);

    const alongCurve = (count: number) => ({
      version: GEOM_VERSION,
      nodes: [
        { kind: 'mass', variant: 'block' },
        { kind: 'arrayAlongCurve', child: 0, count: 3, points: points(count) },
      ],
      root: 1,
    });

    expect(validateGeomProgram(alongCurve(MAX_CURVE_POINTS)).ok).toBe(true);
    expect(validateGeomProgram(alongCurve(MAX_CURVE_POINTS + 1)).ok).toBe(false);
  });

  it('nejdražší povolený sweep se vejde do rozpočtu jednoho kusu', () => {
    // Plášť je `dílky × body profilu × 2` trojúhelníků, obě víka
    // `2 × (body − 2)`. Součin tří stropů se počítá tady, aby zvednutí
    // kteréhokoli z nich spadlo dřív, než se objeví v rozpočtu světa.
    const shell = MAX_SWEEP_SEGMENTS * MAX_CURVE_POINTS * 2;
    const caps = 2 * (MAX_CURVE_POINTS - 2);

    expect(shell + caps).toBeLessThanOrEqual(KIT_BUDGETS.maxTrianglesPerPiece);
  });

  it('plocha profilu má znaménko podle pořadí bodů', () => {
    const square = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const;

    expect(profileArea(square)).toBeCloseTo(4, 12);
    expect(profileArea([...square].reverse())).toBeCloseTo(-4, 12);
  });

  it.each([
    ['profil o dvou bodech', { profile: [[0, 0], [1, 1]] }],
    ['profil nad stropem', { profile: Array.from({ length: MAX_CURVE_POINTS + 1 }, (_u, i) => [i, i]) }],
    ['dráha o jediném bodu', { path: [[0, 0, 0]] }],
    ['jediný dílek', { segments: 1 }],
    ['dílky nad stropem', { segments: MAX_SWEEP_SEGMENTS + 1 }],
    ['zlomkový počet dílků', { segments: 8.5 }],
    ['odstín mimo kit', { swatch: 'lilac' }],
    ['pole navíc', { thickness: 0.2 }],
    ['NaN v profilu', { profile: [[0, 0], [1, Number.NaN], [1, 1]] }],
    ['souřadnice dráhy mimo rozsah', { path: [[0, 0, 0], [900, 0, 0]] }],
  ])('%s se odmítne', (_name, patch) => {
    expect(validateGeomProgram(sweepProgram(patch)).ok).toBe(false);
  });

  it('profil s nulovou plochou se odmítne, protože by nebyl tenký, ale neviditelný', () => {
    // Tři body na přímce projdou schématem — je to platné pole platných čísel.
    // Vadu vidí až pohled na celé pole, takže patří do strukturální kontroly.
    const collinear = validateGeomProgram(
      sweepProgram({ profile: [[0, 0], [1, 1], [2, 2]] }),
    );

    expect(collinear.ok).toBe(false);
    expect(collinear.issues.join(' ')).toContain('no area');
  });

  it('dráha ze samých stejných bodů se odmítne, protože to není dráha', () => {
    const still = validateGeomProgram(
      sweepProgram({ path: [[2, 1, 3], [2, 1, 3], [2, 1, 3]] }),
    );

    expect(still.ok).toBe(false);
    expect(still.issues.join(' ')).toContain('identical points');
  });

  it('dráha, kde se shoduje jen část bodů, projde', () => {
    // Zdvojený bod je legitimní způsob, jak křivku u konce přibrzdit. Odmítnutí
    // by tady zakázalo tvar, na kterém není nic špatného.
    expect(validateGeomProgram(sweepProgram({ path: [[0, 0, 0], [0, 0, 0], [0, 2, 3]] })).ok).toBe(
      true,
    );
  });

  it('sweep je tvar, ne operace — do rozpočtu instancí se počítá jako jeden kus', () => {
    expect(instanceCounts([sweepNode()])).toEqual([1]);
    expect(childIndicesOf(sweepNode())).toEqual([]);
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

  it('potomek mimo tabulku jmenuje tabulku, a jenom to', () => {
    // Nález `T7-gate-deadcheck`: hlášky se vydávaly za sebou, takže ta
    // o tabulce se u potomka nikdy neozvala sama — potomek mimo tabulku je
    // vždycky i nad vlastním řádkem. Délka se čte z programu, neopisuje se.
    const size = coveringProgram().nodes.length;
    const result = validateGeomProgram(
      broken((program) => {
        (program.nodes[3] as { child: number }).child = size + 6;
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.join(' | ')).toContain(
      `node 3 references node ${String(size + 6)} outside the table of ${String(size)}`,
    );
    expect(result.issues.join(' | ')).not.toContain('at or above itself');
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
      // Číslo se pohnulo z 11 na 14 v P13 vlně 1 T6 a je to zapsané, ne
      // přepsané: pokrývající program musí obsahovat každý druh uzlu, a přibyly
      // `arrayAlongCurve`, `anchorTo` a skupina, která je drží. Kdyby se
      // pohnulo bez toho, aby tabulka vyrostla, znamená to, že se z fixture
      // něco ztratilo.
      // Délka se čte z programu, ne opisuje: pin je na hlášku s důvodem, ne na
      // to, kolik uzlů zrovna má pokrývající program.
      new RegExp(`root references node 40 outside the table of ${String(coveringProgram().nodes.length)}`),
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

/**
 * P13 vlna 1 T6 — co jazyk umí navíc a co u toho nesmí povolit.
 *
 * Tři vlastnosti, na kterých ta úloha stojí: kotva je odkaz a musí mířit dolů,
 * křivkové pole platí do rozpočtu jako každé jiné, a volné otáčení je
 * **nadmnožina** kvadrantů, ne jejich náhrada.
 */
describe('rozšíření jazyka o křivku, kotvu a volné otáčení', () => {
  it('strop uzlů je 96 a devadesát sedm se odmítne', () => {
    expect(GEOM_LIMITS.maxNodes).toBe(96);

    const nodes: GeomNode[] = Array.from({ length: 97 }, () => ({
      kind: 'mass',
      variant: 'block',
    }));

    expect(validateGeomProgram({ version: GEOM_VERSION, nodes, root: 0 }).ok).toBe(false);
  });

  it('kotva na uzel nad sebou nebo na sebe se odmítne', () => {
    for (const target of [12, 13]) {
      const result = validateGeomProgram(
        broken((program) => {
          (program.nodes[12] as { target: number }).target = target;
        }),
      );

      expect(result.ok, `target ${target} prošel`).toBe(false);
      expect(result.issues.join(' | ')).toMatch(
        new RegExp(`node 12 references node ${target} at or above itself`),
      );
    }
  });

  it('kotva se počítá jako posun, ne jako druhý kus', () => {
    const counts = instanceCounts(parseGeomProgram(coveringProgram()).nodes);

    // Uzel 12 kotví jediný strom (uzel 9) na plošinu (uzel 1). Cíl se do
    // výsledku nedostane, takže z kotvy vyleze právě jeden kus.
    expect(counts[12]).toBe(1);
  });

  it('křivkové pole započítává rozvinuté kopie do stropu kusů', () => {
    const explosive = {
      version: GEOM_VERSION,
      nodes: [
        { kind: 'mass', variant: 'block' },
        { kind: 'repeat', child: 0, count: 6, step: [1, 0, 0] },
        {
          kind: 'arrayAlongCurve',
          child: 1,
          count: 24,
          points: [
            [0, 0, 0],
            [10, 4, 0],
            [20, 0, 0],
          ],
        },
      ],
      root: 2,
    };

    const result = validateGeomProgram(explosive);
    expect(result.ok).toBe(false);
    expect(result.issues.join(' | ')).toMatch(
      /expands to 144 placed pieces, above maxInstances 120/,
    );
  });

  it('křivka nesmí mít víc kontrolních bodů, než jazyk dovolí', () => {
    const result = validateGeomProgram(
      broken((program) => {
        (program.nodes[11] as { points: number[][] }).points = Array.from(
          { length: MAX_CURVE_POINTS + 1 },
          (_unused, index) => [index, 0, 0],
        );
      }),
    );

    expect(result.ok).toBe(false);
  });

  it('volné otáčení je nadmnožina kvadrantů: yak 0,37 projde, celá otáčka ne', () => {
    const fractional = broken((program) => {
      program.nodes[1] = { kind: 'mass', variant: 'block', yaw: 0.37, pitch: -1.2, roll: 2.9 };
    });

    expect(validateGeomProgram(fractional).ok).toBe(true);

    const fullTurn = broken((program) => {
      program.nodes[1] = { kind: 'mass', variant: 'block', yaw: 4 };
    });

    expect(validateGeomProgram(fullTurn).ok).toBe(false);
  });
});
