/**
 * Router patche — **dráhu rozhodují cesty, štítek se jen zapisuje**.
 *
 * Oracle téhle úlohy není fixtura autorovaná vedle implementace: kontrakt routeru
 * je ve zmrazeném `protocol.v1.json` pod `editContract.router` a čte se odtamtud.
 * Tenhle soubor tedy neopisuje pravidla, se kterými se pak sám poměřuje — to je
 * kruhový oracle, za který tenhle projekt zaplatil u T8b i u T12.
 *
 * Základní svět je zmrazená emise `C01`, ne syntetická fixtura, takže cesty
 * v patchích míří na místa, která ve skutečném korpusu existují.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Operation } from 'rfc6902';
import { beforeEach, describe, expect, it } from 'vitest';

import { commitPart } from '../../ir/revision';
import { ruleKeyFault, sealSimHash, worldDocSchema, type LookPart, type WorldDoc } from '../../ir/worlddoc';
import { withRequest } from '../../obs/trace';
import { drainRoutingAnomalies, routePatch, runLookLane, type LabelledPatch } from '../router';

function frozen(...parts: string[]): string {
  return readFileSync(join(process.cwd(), 'evals', 'frozen', ...parts), 'utf8');
}

interface FrozenResponse {
  readonly forPrompt: string;
  readonly baseWorld?: string;
  readonly body: unknown;
}

const responses: readonly FrozenResponse[] = frozen('responses', 'index.jsonl')
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line) as FrozenResponse);

const creates = responses.filter((entry) => !Array.isArray(entry.body));
const edits = responses.filter((entry) => Array.isArray(entry.body));

const protocol = JSON.parse(frozen('protocol.v1.json')) as {
  editContract: {
    router: {
      decidesFrom: string;
      decidesFromLabel: boolean;
      simWinsRule: string;
      labelMismatch: string;
      mixedPatch: string;
    };
  };
};

const CONTRACT = protocol.editContract.router;

function fixture(name: string): LabelledPatch & { readonly baseWorld: string } {
  return JSON.parse(readFileSync(join(process.cwd(), 'src', 'patch', '__fixtures__', name), 'utf8')) as LabelledPatch & {
    readonly baseWorld: string;
  };
}

const MISLABELLED = fixture('mislabelled.patch.json');
const MIXED = fixture('mixed.patch.json');

/** Zmrazená emise, zapečetěná systémem — `simHash` model neemituje. */
function worldOf(forPrompt: string): WorldDoc {
  const create = creates.find((entry) => entry.forPrompt === forPrompt);
  if (create === undefined) throw new Error(`${forPrompt} není ve zmrazeném korpusu`);
  const parsed = worldDocSchema.safeParse(sealSimHash(create.body as Record<string, unknown> & { sim: unknown }));
  if (!parsed.success) throw new Error(`${forPrompt}: ${JSON.stringify(parsed.error.issues[0])}`);
  return parsed.data;
}

const C01 = worldOf('C01');

/** Rozřazený patch commitnutý na svou část — dráha končí tady, ne v routeru. */
function commitRouted(doc: WorldDoc, routed: { part: 'sim' | 'look'; operations: readonly Operation[] }) {
  return commitPart(doc, {
    part: routed.part,
    baseRevision: routed.part === 'sim' ? doc.simRevision : doc.lookRevision,
    operations: routed.operations,
  });
}

beforeEach(() => {
  drainRoutingAnomalies();
});

describe('kontrakt routeru se čte ze zmrazeného protokolu', () => {
  it('a protokol opravdu říká, že štítek nerozhoduje', () => {
    // Kdyby tenhle blok zmizel, všechny testy níž by se poměřovaly s vlastním
    // popisem místo se zmrazeným artefaktem.
    expect(CONTRACT.decidesFromLabel).toBe(false);
    expect(CONTRACT.decidesFrom).toContain('normalizované');
    expect(CONTRACT.simWinsRule).toContain('/sim');
    expect(CONTRACT.simWinsRule).toContain('BEZPODMÍNEČNĚ');
    expect(CONTRACT.labelMismatch).toContain('NENÍ důvod k odmítnutí');
    expect(CONTRACT.mixedPatch).toContain('dva patche');
  });
});

describe('simWinsRule — zápis pod `/sim` jde do dráhy pravidel bez ohledu na štítek', () => {
  it('štítek `look` a jedna operace pod `/sim` skončí v dráze pravidel', () => {
    expect(MISLABELLED.label).toBe('look');
    expect(MISLABELLED.operations).toHaveLength(1);

    const routing = routePatch(MISLABELLED);
    expect(routing.verdict).toBe('ROUTED');
    if (routing.verdict !== 'ROUTED') return;

    expect(routing.patches).toHaveLength(1);
    expect(routing.patches[0].lane).toBe('rules');
    expect(routing.patches[0].part).toBe('sim');
    // A cesta je přepsaná do souřadnic části, jinak by `commitPart` mířil mimo.
    expect(routing.patches[0].operations[0].path).toBe('/rules/unlock/condition/value');
  });

  it('a NENÍ to odmítnutí — patch se commitne a `sim` se doopravdy změní', () => {
    const routing = routePatch(MISLABELLED);
    if (routing.verdict !== 'ROUTED') throw new Error('patch se nerozřadil');

    const result = commitRouted(C01, routing.patches[0]);
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;

    expect(result.doc.simRevision).toBe(C01.simRevision + 1);
    expect(result.doc.simHash).not.toBe(C01.simHash);
    const rules = result.doc.sim.rules as Record<string, { condition: { value: number } }>;
    expect(rules.unlock.condition.value).toBe(2);
  });

  it('a zároveň po štítku zůstala anomálie', () => {
    const routing = routePatch(MISLABELLED);
    if (routing.verdict !== 'ROUTED') throw new Error('patch se nerozřadil');

    expect(routing.anomalies).toHaveLength(1);
    expect(routing.anomalies[0]).toMatchObject({
      kind: 'label-mismatch',
      label: 'look',
      parts: ['sim'],
      evidence: '/sim/rules/unlock/condition/value',
    });
  });

  it('anomálie jde i do telemetrie, s korelačním ID požadavku', () => {
    withRequest('req-42', () => routePatch(MISLABELLED));

    const drained = drainRoutingAnomalies();
    expect(drained).toHaveLength(1);
    expect(drained[0].requestId).toBe('req-42');
    // Sběr se odčerpáním vyprázdní, jinak by druhý odběratel viděl cizí běh.
    expect(drainRoutingAnomalies()).toHaveLength(0);
  });

  it('mimo požadavek je `requestId` `undefined`, ne vymyšlené', () => {
    routePatch(MISLABELLED);
    expect(drainRoutingAnomalies()[0].requestId).toBeUndefined();
  });

  /**
   * **Tohle je ta aserce, která odlišuje „cesty rozhodly" od „štítek `look` se
   * překlápí na `sim`".** Bez ní by test výš prošel i implementaci, která jen
   * obrací štítek — a ta by u správně oštítkovaného `look` patche selhala.
   */
  it('a týž patch jde do téže dráhy se štítkem `sim` i bez štítku', () => {
    const laneOf = (label?: string) => {
      const routing = routePatch({ label, operations: MISLABELLED.operations });
      if (routing.verdict !== 'ROUTED') throw new Error('patch se nerozřadil');
      return { lane: routing.patches[0].lane, anomalies: routing.anomalies.length };
    };

    expect(laneOf('look')).toEqual({ lane: 'rules', anomalies: 1 });
    expect(laneOf('sim')).toEqual({ lane: 'rules', anomalies: 0 });
    expect(laneOf(undefined)).toEqual({ lane: 'rules', anomalies: 0 });
    // Neznámý štítek je taky neshoda — o dráze pořád rozhodly cesty.
    expect(laneOf('geometry')).toEqual({ lane: 'rules', anomalies: 1 });
  });

  it('a ani `test` pod `/sim` neuteče do dráhy vzhledu', () => {
    // `simWinsRule` mluví o zápisu, vzniku a smazání. Kdyby se čtení smělo rozřadit
    // podle štítku, měl by model dveře, kterými se `/sim` obslouží mimo verifikaci.
    const routing = routePatch({
      label: 'look',
      operations: [{ op: 'test', path: '/sim/grid/cell', value: 1 } as Operation],
    });
    if (routing.verdict !== 'ROUTED') throw new Error('patch se nerozřadil');
    expect(routing.patches[0].lane).toBe('rules');
  });
});

describe('dráha se rozhoduje z NORMALIZOVANÝCH cest, ne porovnáním řetězců', () => {
  it('`/simRevision` a `/simHash` se odmítnou, ačkoli jako řetězec `/sim` začínají', () => {
    // `"/simRevision".startsWith("/sim")` je `true`. Kdyby se rozhodovalo takhle,
    // model by si patchem zvedl vlastní revizi nebo přepečetil vlastní hash — a
    // obojí je zmrazená třída defektu, ne hypotéza.
    for (const path of ['/simRevision', '/simHash', '/lookRevision', '/irVersion']) {
      const routing = routePatch({ operations: [{ op: 'replace', path, value: 99 } as Operation] });
      expect(routing.verdict, path).toBe('REJECTED');
      if (routing.verdict !== 'REJECTED') continue;
      expect(routing.pointer, path).toBe(path);
      expect(routing.expected, path).toContain('/sim or /look');
    }
  });

  it('a člen doslova pojmenovaný `/sim` se do části `sim` nedostane', () => {
    // `/~1sim/rules` je podle RFC 6901 JEDEN token, a ten se jmenuje `/sim`.
    // Syrové porovnání by ho minulo, dekódované spojení by ho naopak propustilo.
    const routing = routePatch({ operations: [{ op: 'replace', path: '/~1sim/rules', value: 1 } as Operation] });
    expect(routing.verdict).toBe('REJECTED');
  });

  it('a kořen dokumentu není cíl patche', () => {
    const routing = routePatch({ operations: [{ op: 'replace', path: '', value: {} } as Operation] });
    expect(routing.verdict).toBe('REJECTED');
  });

  it('a `move` přes hranici částí se odmítne s pointerem', () => {
    // `sim` a `look` se commitují každá proti své revizi, takže „přesuň ze vzhledu
    // do pravidel" není jedna operace, kterou by šlo provést atomicky.
    const routing = routePatch({
      operations: [{ op: 'move', from: '/look/palette', path: '/sim/state/flags/theme' } as Operation],
    });
    expect(routing.verdict).toBe('REJECTED');
    if (routing.verdict !== 'REJECTED') return;
    expect(routing.pointer).toBe('/sim/state/flags/theme');
    expect(routing.detail).toContain('separate revisions');
  });

  it('a operace bez použitelné cesty se odmítne dřív, než se z ní cesta čte', () => {
    const routing = routePatch({ operations: [{ op: 'replace', value: 1 } as unknown as Operation] });
    expect(routing.verdict).toBe('REJECTED');
    if (routing.verdict !== 'REJECTED') return;
    expect(routing.expected).toContain('RFC 6902 operation');
  });

  it('a prázdný patch nemá podle čeho dráhu rozhodnout', () => {
    expect(routePatch({ operations: [] }).verdict).toBe('REJECTED');
  });
});

describe('mixedPatch — smíšený patch se dělí na dva s jedním záměrem', () => {
  it('rozdělí se podle částí a pořadí operací uvnitř každé zůstane', () => {
    const routing = routePatch(MIXED);
    expect(routing.verdict).toBe('ROUTED');
    if (routing.verdict !== 'ROUTED') return;

    expect(routing.patches).toHaveLength(2);
    expect(routing.patches.map((patch) => patch.lane)).toEqual(['look', 'rules']);

    const [look, sim] = routing.patches;
    expect(look.operations.map((operation) => operation.path)).toEqual(['/palette', '/camera/kind']);
    expect(sim.operations.map((operation) => operation.path)).toEqual(['/state/counters/keysHeld/max']);
  });

  it('a anomálie jmenuje obě části, protože štítek nesedí ani jedné', () => {
    const routing = routePatch(MIXED);
    if (routing.verdict !== 'ROUTED') throw new Error('patch se nerozřadil');
    expect(routing.anomalies[0].parts).toEqual(['look', 'sim']);
  });

  it('a oba půlpatche se commitnou — vzhled hned, pravidla do dokumentu se vzhledem', () => {
    const routing = routePatch(MIXED);
    if (routing.verdict !== 'ROUTED') throw new Error('patch se nerozřadil');
    const [lookPatch, simPatch] = routing.patches;

    const look = commitRouted(C01, lookPatch);
    expect(look.verdict).toBe('COMMITTED');
    if (look.verdict !== 'COMMITTED') return;

    // §13.1.1: vzhledový commit NESMÍ posunout revizi pravidel, jinak by se patch
    // pravidel odmítal jako zastaralý, ačkoli se na `sim` nic nezměnilo.
    expect(look.doc.simRevision).toBe(C01.simRevision);
    expect(look.doc.simHash).toBe(C01.simHash);
    expect(look.doc.lookRevision).toBe(C01.lookRevision + 1);

    const sim = commitRouted(look.doc, simPatch);
    expect(sim.verdict).toBe('COMMITTED');
    if (sim.verdict !== 'COMMITTED') return;

    // A vzhled se návratem pravidel nevrátil zpátky.
    expect(sim.doc.look.palette).toBe('amber');
    expect(sim.doc.lookRevision).toBe(C01.lookRevision + 1);
    expect((sim.doc.sim.state as { counters: { keysHeld: { max: number } } }).counters.keysHeld.max).toBe(4);
  });
});

describe('neznámé pole v kterékoli části odmítne schéma', () => {
  it('v `sim` i v `look`, a odmítnutí míří přímo na to pole', () => {
    for (const part of ['sim', 'look'] as const) {
      const routing = routePatch({
        operations: [{ op: 'add', path: `/${part}/smuggled`, value: 1 } as Operation],
      });
      if (routing.verdict !== 'ROUTED') throw new Error(`${part} se nerozřadil`);

      const result = commitRouted(C01, routing.patches[0]);
      expect(result.verdict, part).toBe('REJECTED');
      if (result.verdict !== 'REJECTED') continue;
      expect(result.reason, part).toBe('SCHEMA');
      expect(result.pointer, part).toBe(`/${part}/smuggled`);
    }
  });
});

describe('dráha vzhledu — sémanticky neodmítá, technicky ano', () => {
  const lookPatchOf = (patch: LabelledPatch) => {
    const routing = routePatch(patch);
    if (routing.verdict !== 'ROUTED') throw new Error('patch se nerozřadil');
    const look = routing.patches.find((candidate) => candidate.part === 'look');
    if (look === undefined) throw new Error('patch nemá vzhledovou půlku');
    return { part: 'look' as const, baseRevision: C01.lookRevision, operations: look.operations };
  };

  const repaint: LabelledPatch = {
    label: 'look',
    operations: [{ op: 'replace', path: '/look/palette', value: 'amber' } as Operation],
  };

  it('platný vzhled se commitne a stavba geometrie vidí NOVÝ look', () => {
    const seen: LookPart[] = [];
    const outcome = runLookLane(C01, lookPatchOf(repaint), (look) => void seen.push(look));

    expect(outcome.verdict).toBe('COMMITTED');
    expect(outcome.doc.lookRevision).toBe(C01.lookRevision + 1);
    expect(seen).toHaveLength(1);
    expect(seen[0].palette).toBe('amber');
    // Vzhled je mimo hash — simulace se kvůli němu nepozastavuje ani nepřepečeťuje.
    expect(outcome.doc.simHash).toBe(C01.simHash);
    expect(outcome.doc.simRevision).toBe(C01.simRevision);
  });

  it('pád stavby geometrie se zachytí a vrátí PŘEDCHOZÍ look, ne prázdnou obrazovku', () => {
    const outcome = runLookLane(C01, lookPatchOf(repaint), () => {
      throw new Error('unknown module family');
    });

    expect(outcome.verdict).toBe('REVERTED');
    expect(outcome.reverted).toContain('unknown module family');
    // Přesně to, co AC žádá: předchozí `look` a předchozí revize.
    expect(outcome.doc.look).toEqual(C01.look);
    expect(outcome.doc.lookRevision).toBe(C01.lookRevision);
    expect(outcome.doc).toEqual(C01);
  });

  it('a výjimka se ven nedostane ani jako `throw` mimo `Error`', () => {
    expect(() =>
      runLookLane(C01, lookPatchOf(repaint), () => {
        throw 'a bare string';
      }),
    ).not.toThrow();
  });

  it('odmítnutý vzhled nechá dokument bitově nedotčený', () => {
    const outcome = runLookLane(
      C01,
      { part: 'look', baseRevision: C01.lookRevision, operations: [{ op: 'add', path: '/rogue', value: 1 } as Operation] },
      () => {
        throw new Error('stavba se neměla vůbec spustit');
      },
    );

    expect(outcome.verdict).toBe('REJECTED');
    expect(outcome.rejection?.reason).toBe('SCHEMA');
    expect(outcome.doc).toEqual(C01);
  });

  it('a `sim` patch se do dráhy vzhledu nepustí', () => {
    const outcome = runLookLane(
      C01,
      { part: 'sim', baseRevision: C01.simRevision, operations: [{ op: 'replace', path: '/grid/cell', value: 2 } as Operation] },
      () => undefined,
    );
    expect(outcome.verdict).toBe('REJECTED');
    expect(outcome.doc).toEqual(C01);
  });
});

/**
 * **Rozhodnutí předané z T12 do T22: `-` a číselný token nad `rules`.**
 *
 * Zvolena varianta (b) ze tří, které si T22 zapsal — přijmout tvar cesty (RFC 6901
 * ho povoluje a rozbor s knihovnou se rozcházet nemá) a vynutit **invariant, o který
 * doopravdy jde**: pravidlo musí ležet pod svým `id`. Varianta (a) by zakázala `-`
 * nad objektem obecně, tedy i tam, kde se žádné adresování nerozbíjí; varianta (c)
 * by vadu poslala do scoreru, kde už je z ní commitnutý dokument.
 *
 * Charakterizační test v `two-revisions.test.ts` je tím obrácený — přesně jak si
 * ve svém docblocku vyžádal.
 */
describe('rozhodnutí T22: pravidlo musí ležet pod svým `id`', () => {
  const rule = JSON.parse(
    '{"id":"lose","phase":0,"priority":9,"event":{"kind":"onStart"},"condition":null,"actions":[{"kind":"lose"}]}',
  ) as unknown;

  it('`add /sim/rules/-` i `/sim/rules/0` se odmítnou, protože klíč a `id` se rozejdou', () => {
    for (const token of ['-', '0']) {
      const routing = routePatch({ operations: [{ op: 'add', path: `/sim/rules/${token}`, value: rule } as Operation] });
      if (routing.verdict !== 'ROUTED') throw new Error(`${token} se nerozřadil`);

      const result = commitRouted(C01, routing.patches[0]);
      expect(result.verdict, token).toBe('REJECTED');
      if (result.verdict !== 'REJECTED') continue;
      expect(result.reason, token).toBe('STRUCTURE');
      expect(result.pointer, token).toBe(`/sim/rules/${token}`);
      expect(result.detail, token).toContain('stable id');
    }
  });

  it('ale `add /sim/rules/lose` projde — vadné je rozejití, ne tvar cesty', () => {
    const routing = routePatch({ operations: [{ op: 'add', path: '/sim/rules/lose', value: rule } as Operation] });
    if (routing.verdict !== 'ROUTED') throw new Error('patch se nerozřadil');

    const result = commitRouted(C01, routing.patches[0]);
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;
    expect(Object.keys(result.doc.sim.rules as object)).toContain('lose');
  });

  it('a `-` mimo `rules` zůstává legální, protože tam žádný invariant neláme', () => {
    // Zúžení míří na adresování pravidel, ne na tvar cesty obecně. `-` je podle
    // RFC 6901 nad objektem obyčejné jméno členu a `/sim/state/counters` žádné
    // `id == klíč` nedeklaruje.
    const routing = routePatch({
      operations: [{ op: 'add', path: '/sim/state/counters/keysHeld/-', value: 9 } as Operation],
    });
    if (routing.verdict !== 'ROUTED') throw new Error('patch se nerozřadil');
    expect(commitRouted(C01, routing.patches[0]).verdict).toBe('COMMITTED');
  });

  it('a `replace` na samotné `id` se odmítne stejně, protože měří výsledek', () => {
    // Kdyby se kontrola ptala na tvar OPERACE, tahle cesta by ji obešla: klíč se
    // nehne, rozejde se `id`.
    const routing = routePatch({
      operations: [{ op: 'replace', path: '/sim/rules/unlock/id', value: 'renamed' } as Operation],
    });
    if (routing.verdict !== 'ROUTED') throw new Error('patch se nerozřadil');

    const result = commitRouted(C01, routing.patches[0]);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.pointer).toBe('/sim/rules/unlock');
  });
});

describe('proti zmrazenému korpusu, ne proti vlastní fixtuře', () => {
  it('všech 15 create těl splňuje `id == klíč` — kontrolou z produkční cesty', () => {
    // Táž funkce, jakou volá `sealPart`. Druhá implementace téhož by měřila sebe.
    let bodies = 0;
    let rules = 0;
    for (const create of creates) {
      const sim = (create.body as { sim: unknown }).sim;
      expect(ruleKeyFault(sim), create.forPrompt).toBeNull();

      // `C14` a `C15` nesou `sim: null` — jsou to záznamy odmítnutí (`simOutcome`),
      // ne světy, takže pravidla nemají a nemají je mít.
      const table = (sim as { rules?: unknown } | null)?.rules;
      if (table === null || typeof table !== 'object' || Array.isArray(table)) continue;
      bodies += 1;
      rules += Object.keys(table).length;
    }
    // Obě čísla jsou pinutá, aby se sada nemohla tiše vyprázdnit a dál hlásit
    // zeleno nad nulou pravidel. Sedí na to, co naměřilo T12.
    expect(bodies).toBe(13);
    expect(rules).toBe(31);
  });

  it('a všech 25 editačních patchů router rozřadí — na `sim`, protože korpus je celý `/sim`', () => {
    expect(edits).toHaveLength(25);
    for (const edit of edits) {
      const routing = routePatch({ operations: edit.body as Operation[] });
      expect(routing.verdict, edit.forPrompt).toBe('ROUTED');
      if (routing.verdict !== 'ROUTED') continue;
      expect(routing.patches, edit.forPrompt).toHaveLength(1);
      expect(routing.patches[0].part, edit.forPrompt).toBe('sim');
    }
  });

  it('a rozhodnutí T22 nezamítá nic, co korpus deklaruje jako `FULFILLED`', () => {
    // Tohle je ta měřená půlka rozhodnutí: kdyby `id == klíč` shodilo byť jeden
    // zmrazený patch, byla by to varianta, kterou korpus nedovolí.
    for (const edit of edits) {
      const routing = routePatch({ operations: edit.body as Operation[] });
      if (routing.verdict !== 'ROUTED') continue;
      const base = worldOf(edit.baseWorld as string);
      const result = commitRouted(base, routing.patches[0]);
      if (result.verdict !== 'REJECTED') continue;
      expect(result.detail, `${edit.forPrompt} padl na id == klíč`).not.toContain('stable id');
    }
  });
});
