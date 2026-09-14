import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  SCHEMA_NODE_KINDS,
  SHAPE_NODE_GROUPS,
  parseShapeProgram,
  validateShapeProgram,
} from '../schema';
import {
  MAX_BOUNDS_VOLUME_RATIO,
  SHAPE_LIMITS,
  SHAPE_NODE_KINDS,
  childIndicesOf,
  depths,
  evaluationCounts,
  instanceCounts,
  type ShapeNode,
} from '../types';
import {
  arrayProgram,
  chainProgram,
  coveringProgram,
  sharedSubtreeProgram,
  wideProgram,
} from '../__fixtures__/programs';

/**
 * Porouchaná kopie programu.
 *
 * Vrací `Record<string, unknown>`, ne `ShapeProgram`, a je to schválně: brána
 * bere `unknown`, protože vstup přichází od modelu a v tu chvíli o něm typový
 * systém nic neví. Kdyby si testy chystaly vadné programy jako typované
 * `ShapeProgram`, musely by kolem každé vady obcházet `tsc` a měřily by pak
 * něco jiného než to, co branou doopravdy prochází.
 *
 * `structuredClone` a ne rozprostření: vady sedí i uvnitř uzlů a mělká kopie by
 * je nechala prosáknout do dalšího testu.
 */
function broken(mutate: (draft: Record<string, unknown>) => void): Record<string, unknown> {
  const draft = structuredClone(coveringProgram()) as unknown as Record<string, unknown>;
  mutate(draft);
  return draft;
}

/** Uzly porouchané kopie, aby se nemusel opisovat přetyp na každém řádku. */
function nodesOf(draft: Record<string, unknown>): Record<string, unknown>[] {
  return draft.nodes as Record<string, unknown>[];
}

describe('slovník ShapeProgram', () => {
  it('má právě ty skupiny a počty, které předepisuje design book §7.2', () => {
    expect(SHAPE_NODE_GROUPS.primitive).toHaveLength(10);
    expect(SHAPE_NODE_GROUPS.combination).toHaveLength(3);
    expect(SHAPE_NODE_GROUPS.transform).toHaveLength(4);
    expect(SHAPE_NODE_GROUPS.deformation).toHaveLength(5);
    expect(SHAPE_NODE_GROUPS.array).toHaveLength(3);
    expect(SHAPE_NODE_GROUPS.mask).toHaveLength(1);
    // 25 → 26 dne 31. 8. 2026: přibyl `revolve`, protože bez něj jazyk neuměl
    // říct oblouk (P13 `T7-revolve`, nález brány K1).
    expect(SHAPE_NODE_KINDS).toHaveLength(26);
  });

  it('schéma zná přesně ty uzly, které slovník jmenuje', () => {
    expect([...SCHEMA_NODE_KINDS].sort()).toEqual([...SHAPE_NODE_KINDS].sort());
  });

  it('otáčení je volné ve třech osách, ne po kvadrantech', () => {
    const program = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[11] = { kind: 'rotate', child: 1, yaw: 0.37, pitch: -1.11, roll: 2.9 };
      }),
    );
    expect(program.ok).toBe(true);
  });
});

describe('platný program', () => {
  it('projde a použije při tom každý druh uzlu', () => {
    const program = coveringProgram();
    const used = new Set(program.nodes.map((node) => node.kind));

    expect(validateShapeProgram(program)).toEqual({ ok: true, issues: [] });
    expect([...used].sort()).toEqual([...SHAPE_NODE_KINDS].sort());
  });

  it('`parseShapeProgram` vrátí tentýž dokument', () => {
    const program = coveringProgram();
    expect(parseShapeProgram(program)).toEqual(program);
  });

  it('zůstane pod všemi třemi stropy naráz', () => {
    const program = coveringProgram();
    expect(program.nodes.length).toBeLessThanOrEqual(SHAPE_LIMITS.maxNodes);
    expect(depths(program.nodes)[program.root]).toBeLessThanOrEqual(SHAPE_LIMITS.maxDepth);
    expect(instanceCounts(program.nodes)[program.root]).toBeLessThanOrEqual(
      SHAPE_LIMITS.maxInstances,
    );
  });
});

describe('odkazy mezi uzly', () => {
  it('odmítne potomka s indexem vyšším, než má rodič sám', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[10].child = 20;
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('node 10 references node 20 at or above itself');
    // Uzel 20 v tabulce **je** — proto se tady o tabulce mluvit nemá.
    expect(result.issues.join('\n')).not.toContain('node 10 references node 20 outside');
  });

  it('potomek mimo tabulku jmenuje tabulku, a jenom to', () => {
    // Nález `T7-gate-deadcheck`: obě hlášky se vydávaly za sebou, takže ta
    // o tabulce se u potomka neozvala nikdy sama. Model dostával do sebeopravy
    // návod „posuň ho pod sebe" i tam, kde ukazoval na řádek, který neexistuje.
    // Test proto soudí obě strany: co zaznít má, i co zaznít nesmí.
    const size = coveringProgram().nodes.length;
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[10].child = size + 14;
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain(
      `node 10 references node ${String(size + 14)} outside the table of ${String(size)}`,
    );
    expect(result.issues.join('\n')).not.toContain('at or above itself');
  });

  it('odmítne potomka, kterým je uzel sám', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[10].child = 10;
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('node 10 references node 10 at or above itself');
  });

  it('odmítne cyklus, protože cyklus nutně porušuje pořadí indexů', () => {
    // Dvojice uzlů, které ukazují jeden na druhý. V ploché tabulce s pravidlem
    // "potomek má nižší index" se cyklus nedá napsat jinak, takže tahle jediná
    // kontrola pokrývá celou třídu. Hláška je jedna, ne dvě: druhý konec už
    // podmínku splňuje, protože ukazuje dolů.
    const result = validateShapeProgram({
      shapeId: 'cycle',
      stableId: 'cycle-object',
      nodes: [
        { kind: 'translate', child: 1, offset: [0, 0, 0] },
        { kind: 'translate', child: 0, offset: [0, 0, 0] },
      ],
      root: 1,
      targetBounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      anchors: [],
      materialIntent: 'bone',
      priority: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('node 0 references node 1 at or above itself');
  });

  it('odmítne kořen mimo tabulku', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        draft.root = 40;
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain('root references node 40 outside the table');
  });
});

describe('stropy jazyka', () => {
  it('přijme program přesně na stropu uzlů a odmítne o jeden větší', () => {
    const atLimit = wideProgram(SHAPE_LIMITS.maxNodes);
    expect(atLimit.nodes).toHaveLength(SHAPE_LIMITS.maxNodes);
    expect(validateShapeProgram(atLimit)).toEqual({ ok: true, issues: [] });

    const oversized = wideProgram(SHAPE_LIMITS.maxNodes + 1);
    const result = validateShapeProgram(oversized);

    expect(result.ok).toBe(false);
    // Odmítnout, ne oříznout: kdyby brána tabulku zkrátila na 48 řádků, byl by
    // to jiný program než ten, který model napsal, a nikde by to nebylo vidět.
    expect(oversized.nodes).toHaveLength(49);
  });

  it('odmítne řádek, na který se z kořene nedá dostat', () => {
    // Rozpočty se čtou z `[root]`, takže mrtvý řádek do žádného z nich nespadne.
    // Buď se odmítne tady, nebo se nekontroluje vůbec.
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft).push({ kind: 'sphere', radius: 9 });
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join(' ')).toContain('cannot be reached from root');
  });

  it('odmítne program, který je pod stropem kopií a přesto stojí přes tisíc vyhodnocení', () => {
    const shared = sharedSubtreeProgram();

    // Nejdřív důkaz, že starý rozpočet sám by ho propustil: sedm řádků,
    // hloubka 7, kopie přesně na stropu 256.
    expect(shared.nodes).toHaveLength(7);
    expect(instanceCounts(shared.nodes)[shared.root]).toBe(SHAPE_LIMITS.maxInstances);
    expect(depths(shared.nodes)[shared.root]).toBeLessThanOrEqual(SHAPE_LIMITS.maxDepth);

    const result = validateShapeProgram(shared);
    expect(result.ok).toBe(false);
    expect(result.issues).toContain(
      'program costs 1061 evaluations per cell, above maxEvaluations 512',
    );
  });

  it('vyhodnocení počítá sdílený podstrom tolikrát, kolikrát se na něj ukazuje', () => {
    const nodes: ShapeNode[] = [
      { kind: 'sphere', radius: 0.5 },
      { kind: 'union', children: [0, 0, 0] },
    ];
    // Kopie: tři listy. Vyhodnocení: tři koule plus samo sjednocení.
    expect(instanceCounts(nodes)[1]).toBe(3);
    expect(evaluationCounts(nodes)[1]).toBe(4);
  });

  it('přijme strom přesně na stropu hloubky a odmítne o jeden hlubší', () => {
    expect(validateShapeProgram(chainProgram(SHAPE_LIMITS.maxDepth)).ok).toBe(true);

    const result = validateShapeProgram(chainProgram(SHAPE_LIMITS.maxDepth + 1));
    expect(result.ok).toBe(false);
    expect(result.issues).toContain(`program is ${SHAPE_LIMITS.maxDepth + 1} nodes deep, above maxDepth ${SHAPE_LIMITS.maxDepth}`);
  });

  it('přijme rozvinutí přesně na stropu kopií a odmítne o jedno větší', () => {
    expect(validateShapeProgram(arrayProgram(16, 16)).ok).toBe(true);

    const result = validateShapeProgram(arrayProgram(17, 16));
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('program expands to 272 copies, above maxInstances 256');
  });

  it('počítá kopie po rozvinutí, ne řádky tabulky', () => {
    // Tři řádky, 512 kopií. Kdyby rozpočet měřil tabulku, projde to.
    const exploding = arrayProgram(32, 16);
    expect(exploding.nodes).toHaveLength(3);
    expect(validateShapeProgram(exploding).ok).toBe(false);
  });

  it('zrcadlo se do stropu kopií nezapočítává, protože nic nestojí', () => {
    const nodes: ShapeNode[] = [
      { kind: 'sphere', radius: 0.5 },
      { kind: 'mirror', child: 0, axis: 'x' },
      { kind: 'mirror', child: 1, axis: 'z' },
    ];
    expect(instanceCounts(nodes)).toEqual([1, 1, 1]);
  });
});

describe('tvar jednoho řádku', () => {
  it('odmítne pole, o kterém slovník neví', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[0].radius2 = 3;
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join(' ')).toContain('schema:/nodes/0');
  });

  it('odmítne uzel, o kterém slovník neví', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[0] = { kind: 'metaball', radius: 1 };
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('konečnost drží `zod` sám, ne meze schématu', () => {
    // Hlavička `schema.ts` na tomhle tvrzení stojí, tak ať se ozve, kdyby
    // `zod` chování změnil. Testy níž ho neověří: každé pole tam odmítne
    // vlastní horní mez dřív, než se na konečnost vůbec dojde.
    expect(z.number().safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(z.number().safeParse(Number.NEGATIVE_INFINITY).success).toBe(false);
    expect(z.number().safeParse(Number.NaN).success).toBe(false);
  });

  it('odmítne nekonečno v každém čísle, na které se dá sáhnout', () => {
    for (const [index, field] of [
      [0, 'radius'],
      [4, 'height'],
      [17, 'amplitude'],
      [18, 'count'],
    ] as const) {
      const result = validateShapeProgram(
        broken((draft) => {
          nodesOf(draft)[index][field] = Number.POSITIVE_INFINITY;
        }),
      );
      expect(result.ok, `${field} přijalo nekonečno`).toBe(false);
    }
  });

  it('odmítne konečný nesmysl, ne jen nekonečno', () => {
    // Tohle je vlastnost, kterou hlídají horní meze. Nekonečno zastaví `zod`
    // sám (viz komentář v `schema.ts`), ale poloměr 10⁶ je platné číslo: projde
    // vyhodnocovačem, zabere celou mřížku a v obraze z něj nezůstane nic.
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[0].radius = 1_000_000;
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('odmítne NaN', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[0].radius = Number.NaN;
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('odmítne nulový poloměr, ze kterého je díra místo tvaru', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[0].radius = 0;
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('odmítne nulovou normálu, která by se normalizovala na NaN', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[7].normal = [0, 0, 0];
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('node 7 is a plane with a zero normal');
  });

  it('odmítne i normálu, která je nenulová a přesto podteče', () => {
    // `1e-200` není nula, ale druhá mocnina podteče na nulu, odmocnina taky,
    // dělení jí dá nekonečno a `Infinity * 0` je NaN. Kontrola proto měří
    // délku, ne rovnost s nulou.
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[7].normal = [1e-200, 0, 0];
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('node 7 is a plane with a zero normal');
  });

  it('odmítne opakování s nulovým krokem, které dělí nulou', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[18].step = [0, 0, 0];
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('node 18 repeats with a step of no length');
  });

  it('odmítne křivku, jejíž dva sousední body leží na sobě', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[20].points = [
          [1, 1, 1],
          [1, 1, 1],
        ];
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('node 20 has curve points 0 and 1 on top of each other');
  });

  it('ostrá hrana se píše vynecháním `k`, ne nulou', () => {
    // `k = 0` je v polynomiálním smooth-min dělení nulou přesně na ploše, kde
    // se potomci potkají — tedy tam, kvůli čemu se ten uzel píše.
    expect(
      validateShapeProgram(
        broken((draft) => {
          nodesOf(draft)[22].k = 0;
        }),
      ).ok,
    ).toBe(false);

    expect(
      validateShapeProgram(
        broken((draft) => {
          delete nodesOf(draft)[22].k;
        }),
      ).ok,
    ).toBe(true);
  });

  it('odmítne víc kontrolních bodů křivky, než jich jazyk dovolí', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        nodesOf(draft)[20].points = Array.from({ length: SHAPE_LIMITS.maxCurvePoints + 1 }, () => [
          0, 0, 0,
        ]);
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('obálka programu', () => {
  it('odmítne rozlišení mřížky, kvalitu i pořadí meshingu', () => {
    // Design book §9.5: tohle jsou rozhodnutí potrubí. Kdyby si je model psal
    // sám, nešlo by tentýž objekt přemeshovat v jiné přesnosti beze změny
    // programu — a hot-swap by přestal být tentýž objekt.
    for (const field of ['resolution', 'quality', 'meshOrder']) {
      const result = validateShapeProgram(
        broken((draft) => {
          draft[field] = 64;
        }),
      );
      expect(result.ok, `${field} prošlo do programu`).toBe(false);
    }
  });

  it('odmítne kvádr, který má minimum nad maximem', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        draft.targetBounds = { min: [1, 0, 0], max: [-1, 1, 1] };
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('targetBounds is flat or inverted on at least one axis');
  });

  it('odmítne i kvádr plochý v jedné ose', () => {
    // List nebo deska je naprosto pravděpodobná emise, a přitom podle
    // `targetBounds` potrubí tvar mřížkuje: nulová tloušťka je krok buňky
    // `(max - min) / N = 0`, tedy dělení nulou a prázdný mesh.
    const result = validateShapeProgram(
      broken((draft) => {
        draft.targetBounds = { min: [-2, 0, -2], max: [2, 0, 2] };
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('targetBounds is flat or inverted on at least one axis');
  });

  it('odmítne dvě kotvy téhož jména', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        draft.anchors = [
          { name: 'mouth', at: [0, 1, 0] },
          { name: 'mouth', at: [0, 2, 0] },
        ];
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('anchor mouth is declared twice');
  });

  it('odmítne celou větu místo identifikátoru', () => {
    const result = validateShapeProgram(
      broken((draft) => {
        draft.stableId = 'the whale skeleton with a cathedral inside it';
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('vrátí všechny nálezy naráz, ne první', () => {
    // Sebeoprava dostane jeden seznam a napíše program znovu. Kdyby brána
    // vracela první chybu, stálo by odmítnutí tolik kol, kolik je v programu vad.
    const result = validateShapeProgram(
      broken((draft) => {
        draft.targetBounds = { min: [1, 1, 1], max: [-1, -1, -1] };
        draft.anchors = [
          { name: 'mouth', at: [0, 1, 0] },
          { name: 'mouth', at: [0, 2, 0] },
        ];
      }),
    );
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('`parseShapeProgram` vyhodí s důvodem, ne s prázdnou hláškou', () => {
    expect(() => parseShapeProgram(broken((draft) => (draft.root = 40)))).toThrow(
      /invalid shape program: root references node 40/,
    );
  });
});

describe('průchody nad tabulkou', () => {
  it('kombinace nese víc potomků, transformace jednoho, primitivum žádné', () => {
    const program = coveringProgram();
    expect(childIndicesOf(program.nodes[0])).toEqual([]);
    expect(childIndicesOf(program.nodes[10])).toEqual([0]);
    // Kořen se jmenuje `program.root`, ne indexem: připnuté číslo se posunulo
    // hned s prvním uzlem, který do fixture přibyl (`revolve`, 31. 8. 2026).
    expect(childIndicesOf(program.nodes[program.root])).toEqual([19, 20, 21, 22, 23, 24, 25]);
    expect(childIndicesOf(program.nodes[25]), 'revolve nese jednoho potomka').toEqual([2]);
  });
});

/* ------------------------------------------------------------------ *
 * Přesah vlastního kvádru. `T12-boundsratio`.
 * ------------------------------------------------------------------ */

/**
 * **Program smí přetéct kvádr, který si sám deklaruje, a do 1. 9. 2026 to nikdo
 * neměřil.** `structuralIssues` soudilo `targetBounds` jen na plochost
 * a obrácení; rozsah programu se s ním nesrovnával vůbec, takže koule o poloměru
 * 5 v kvádru ±0,7 byla platný program.
 *
 * Praskne to až v meshovači, a to špatně: `paddedBounds` naměřilo, že tvar
 * přetékající svůj kvádr o 1e-6 **bez rezervy zmizí úplně** (0 trojúhelníků).
 * Model se tedy dozví „nic nevzniklo" místo „přestřelil jsi o tolik", a až po
 * zaplaceném volání.
 */
describe('přesah vlastního kvádru', () => {
  function programWith(
    nodes: readonly ShapeNode[],
    targetBounds: { min: [number, number, number]; max: [number, number, number] },
  ) {
    return {
      shapeId: 'bounds-case',
      stableId: 'bounds-object',
      nodes,
      root: nodes.length - 1,
      targetBounds,
      anchors: [],
      materialIntent: 'clay',
      priority: 0,
    };
  }

  const SMALL_BOX = { min: [-0.7, -0.7, -0.7] as [number, number, number], max: [0.7, 0.7, 0.7] as [number, number, number] };

  it('koule o poloměru 5 v kvádru ±0,7 se odmítne s poměrem objemů', () => {
    const result = validateShapeProgram(programWith([{ kind: 'sphere', radius: 5 }], SMALL_BOX));

    expect(result.ok).toBe(false);
    // 10³ proti 1,4³ je 364,4 — číslo je v hlášce proto, aby z ní šla napsat
    // opravná věta. „Přetéká" bez čísla neřekne modelu, o kolik má ubrat.
    expect(result.issues).toContain(
      'shape overflows its own targetBounds on x, y, z: generated bounds were 364.4× the requested volume',
    );
  });

  it('tvar přesně na hranici projde', () => {
    // Rovnost není přesah. Kdyby brána soudila `<=`, odmítla by přesně ten
    // tvar, o který se snaží každá poctivá emise: vyplnit svůj kvádr.
    const result = validateShapeProgram(programWith([{ kind: 'sphere', radius: 0.7 }], SMALL_BOX));
    expect(result).toEqual({ ok: true, issues: [] });
  });

  /**
   * ⚠ **Tenhle test tvrdil do 7. 9. 2026 pravý opak a je to vědomá změna,
   * ne regrese.** Jmenoval se „kritérium je přesah po osách, ne poměr objemů"
   * a žádal odmítnutí. `T14r-shapebounds` přeměřila, co ta brána doopravdy
   * dělá: nad prvním živým během padlo výhradně na ní **deset tvarů, a devět
   * z nich se vymeshuje a padne do své krabice** (největší přesah naměřeného
   * rozpětí 4,7 %). Odmítala tedy podle konzervativního statického obalu, ne
   * podle toho, co vyleze, a stála šest vět z třiceti.
   *
   * Desátý vrátí prázdný mesh — přesně to, proti čemu brána vznikla. Jenže na
   * prázdno má meshovač **vlastní detektor na výsledku**, který vrátí
   * pojmenovaný důvod; tenhle byl jeho odhadem předem.
   */
  it('malý tvar, který z krabice čouhá, se pustí — na prázdno je detektor níž', () => {
    const result = validateShapeProgram(
      programWith(
        [
          { kind: 'sphere', radius: 0.2 },
          { kind: 'translate', child: 0, offset: [3, 0, 0] },
        ],
        SMALL_BOX,
      ),
    );

    expect(result).toEqual({ ok: true, issues: [] });
  });

  it('práh je tentýž, kterým měří naměřený mesh druhá brána', () => {
    // Dvě čísla pro tutéž otázku se rozejdou při prvním ladění. Statický obal
    // je konzervativní, tedy vždycky ≥ naměřenému, takže tahle strana je tím
    // prahem přísnější — a je to tak správně.
    expect(MAX_BOUNDS_VOLUME_RATIO).toBe(2);

    // Failure path prahu: těsně nad ním se odmítá, těsně pod ním ne. Kdyby
    // brána zmizela úplně, prošel by i program, který si krabice nevšímá.
    const edge = (over: number) =>
      validateShapeProgram(
        programWith([{ kind: 'sphere', radius: 0.7 * Math.cbrt(over) }], SMALL_BOX),
      );

    expect(edge(MAX_BOUNDS_VOLUME_RATIO * 1.2).ok).toBe(false);
    expect(edge(MAX_BOUNDS_VOLUME_RATIO * 0.9)).toEqual({ ok: true, issues: [] });
  });

  it('co se spočítat nedá, se neodmítá — otočený tvar projde', () => {
    // **Tohle není mezera, je to celý návrh.** Ze samotného kvádru potomka
    // skutečný obal otočeného tvaru spočítat nejde; horní odhad by odmítal
    // tvary, které se vejdou, a to je horší vada než neodhalený přesah —
    // model by dostal opravnou větu k něčemu, co bylo správně.
    const result = validateShapeProgram(
      programWith(
        [
          { kind: 'sphere', radius: 5 },
          { kind: 'rotate', child: 0, yaw: 0.5, pitch: 0, roll: 0 },
        ],
        SMALL_BOX,
      ),
    );
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it('sjednocení soudí podle potomka, kterého spočítat umí', () => {
    // Jeden potomek je otočený (nespočítatelný), druhý je obyčejná koule.
    // Obal sjednocení obsahuje obal každého potomka, takže z toho známého se
    // přesah pozná — abstinence u sourozence ho nesmí umlčet.
    const result = validateShapeProgram(
      programWith(
        [
          { kind: 'sphere', radius: 0.3 },
          { kind: 'rotate', child: 0, yaw: 0.5, pitch: 0, roll: 0 },
          { kind: 'sphere', radius: 4 },
          { kind: 'union', children: [1, 2] },
        ],
        SMALL_BOX,
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain('shape overflows its own targetBounds');
  });
});
