/**
 * Mechanická oprava proti **zmrazené** sadě z T2 — ne proti fixtuře autorované
 * v tomhle commitu.
 *
 * ## Co tady znamená „validní"
 *
 * Produkční řetěz emisní cesty **až po snížení do IR**: schéma dokumentu →
 * osiřelé odkazy → validace `look` → `buildRuntimeWorld`. Je to týž řetěz a
 * tytéž funkce, které volá `POST /api/emit` (T13), jen bez posledního kroku.
 *
 * **Replay svědka do oracle nepatří a je to měření, ne úvaha.** Ověřeno nad
 * zmrazenou sadou: `M01`, `M10`, `M14`, `M18`, `M24`, `M26`, `M28` i `M29`
 * projdou celý řetěz a padnou teprve na `NO_WIN` — mezi nimi tři emise, které
 * korpus deklaruje jako opravitelné. Dosažitelnost výhry je verdikt o světě
 * (`rejection.stage: "witness"`), ne vada tvaru emise, a mechanická oprava ji
 * vyrobit nesmí ani nemá — hledání vítězné stopy je přesně to „hledání, ne
 * oprava", které `M22` mrazí jako neopravitelné.
 *
 * ## Proč se `mustPreserve` čte z korpusu a ne z tabulky tady
 *
 * Anotace je česká věta, takže oracle pro ni musí někdo napsat. Vazba je proto
 * **oboustranná**: každá fráze v korpusu musí mít oracle (jinak by se přidáním
 * fráze tiše nic nezkontrolovalo) a každý oracle musí mít frázi v korpusu
 * (jinak by tabulka přežila změnu korpusu a kontrolovala neexistující slib).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { canonicalRuleOrder, type RuleRecord } from '../../../evals/__tests__/rule-order';
import { buildRuntimeWorld } from '../../ir/build';
import { findDanglingReferences } from '../../ir/references';
import { validateLook, worldEmissionSchema } from '../../ir/worlddoc';
import { TICK_HZ } from '../../sim/clock';
import { repairEmission, type RepairRule } from '../repair';
import { changedLeaves } from '../scope';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const frozenDir = join(repoRoot, 'evals', 'frozen');

interface Malformed {
  readonly id: string;
  readonly defectClass: string;
  readonly repairable: boolean;
  readonly mustPreserve: readonly string[];
  readonly body: unknown;
}

const fixtures = readFileSync(join(frozenDir, 'malformed', 'index.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Malformed);

const protocol = JSON.parse(readFileSync(join(frozenDir, 'protocol.v1.json'), 'utf8')) as {
  readonly malformedFixtures: { readonly repairFloor: { readonly minRepaired: number } };
};

const repairable = fixtures.filter((fixture) => fixture.repairable);

/** Produkční řetěz T13 bez replaye svědka. `null` = validní emise. */
function invalidity(body: unknown): string | null {
  const parsed = worldEmissionSchema.safeParse(body);
  if (!parsed.success) return `schema: ${parsed.error.issues[0].message}`;

  const dangling = findDanglingReferences(parsed.data);
  if (dangling.length > 0) return `references: ${dangling[0].where}`;

  const look = validateLook(parsed.data.look);
  if (!look.ok) return `look: ${look.issues[0]}`;

  const built = buildRuntimeWorld(parsed.data.sim);
  return built.ok ? null : `lowering: ${built.issues[0] ?? built.reason}`;
}

function repairedBody(id: string): unknown {
  const fixture = fixtures.find((entry) => entry.id === id);
  if (fixture === undefined) throw new Error(`${id} není ve zmrazené sadě`);
  return repairEmission(fixture.body).document;
}

function rec(value: unknown): Record<string, unknown> {
  expect(value, 'očekával se záznam').toBeTypeOf('object');
  return value as Record<string, unknown>;
}

function at(value: unknown, ...path: readonly string[]): unknown {
  return path.reduce<unknown>((node, token) => rec(node)[token], value);
}

const rulesOf = (doc: unknown) => rec(at(doc, 'sim', 'rules'));
const entitiesOf = (doc: unknown) => rec(at(doc, 'sim', 'entities'));
const json = (value: unknown) => JSON.stringify(value);

describe('repairEmission — mechanická dávka nad zmrazenou sadou', () => {
  it('nevolá model — na opravné cestě není poskytovatel ani síť', () => {
    const source = readFileSync(join(repoRoot, 'src', 'patch', 'repair.ts'), 'utf8');
    expect(source).not.toMatch(/from '.*model\//);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('opraví nejméně tolik emisí na validní, kolik žádá podlaha protokolu', () => {
    const flipped = fixtures.filter(
      (fixture) => invalidity(fixture.body) !== null && invalidity(repairEmission(fixture.body).document) === null,
    );

    expect(flipped.length).toBeGreaterThanOrEqual(protocol.malformedFixtures.repairFloor.minRepaired);
    // Jmenovitě, ať se podlaha nedá splnit jinou sadou emisí, než která ji plní dnes.
    expect(flipped.map((fixture) => fixture.id)).toEqual([
      'M02',
      'M04',
      'M07',
      'M12',
      'M13',
      'M16',
      'M17',
      'M19',
      'M20',
    ]);
  });

  /**
   * `M06` a `M08` nesou **druhou, nedeklarovanou vadu**: jejich `event.kind` je
   * `onEdge`, tedy IR primitivum, ne jedna ze 14 povrchových událostí, takže po
   * své vlastní deklarované opravě pořád nejdou snížit. Opravovat to nesmí ani
   * tenhle modul (kterou událost autor myslel, je sémantická otázka), ani se
   * nesmí měnit korpus (AC T2b). Je to zapsané, ne zahlazené.
   */
  it('M06 a M08 zůstávají nesnížitelné kvůli vadě, kterou jejich anotace nedeklaruje', () => {
    for (const id of ['M06', 'M08']) {
      expect(invalidity(repairedBody(id)), `${id}`).toMatch(/event onEdge has no lowering/);
    }
  });

  it('žádnou emisi deklarovanou jako neopravitelnou neprohlásí za validní', () => {
    for (const fixture of fixtures.filter((entry) => !entry.repairable)) {
      if (invalidity(fixture.body) === null) continue;
      expect(invalidity(repairEmission(fixture.body).document), `${fixture.id}`).not.toBeNull();
    }
  });

  it('dva běhy dají identický výsledek a vstup nechají nedotčený', () => {
    for (const fixture of fixtures) {
      const before = json(fixture.body);
      const first = repairEmission(fixture.body);
      const second = repairEmission(fixture.body);

      expect(json(first.document), `${fixture.id}: dokument`).toBe(json(second.document));
      expect(first.applied, `${fixture.id}: kroky`).toEqual(second.applied);
      expect(first.refused, `${fixture.id}: odmítnutí`).toEqual(second.refused);
      expect(json(fixture.body), `${fixture.id}: vstup se změnil`).toBe(before);
    }
  });
});

/**
 * Report musí být úplný, ne ilustrativní: co se v dokumentu pohnulo, musí být
 * pod některým vykázaným pointerem. Bez toho by opravář směl tiše změnit cokoli
 * a `mustPreserve` by hlídalo jen ta místa, na která se ho někdo zeptal.
 */
describe('repairEmission — report pokrývá každou změnu', () => {
  it('každý změněný list leží pod pointerem některého vykázaného kroku', () => {
    for (const fixture of fixtures) {
      const report = repairEmission(fixture.body);
      const declared = report.applied.flatMap((step) => step.pointers);
      for (const leaf of changedLeaves(fixture.body, report.document)) {
        expect(
          declared.some((pointer) => leaf === pointer || leaf.startsWith(`${pointer}/`)),
          `${fixture.id}: list ${leaf} se pohnul, ale žádný krok ho nevykázal`,
        ).toBe(true);
      }
    }
  });

  // Druhá polarita: krok, pod kterým se nic nepohnulo, by byl vykázaný no-op.
  // Výjimkou je `order.rules` — pořadí klíčů není list a diff stavu ho nevidí.
  it('krok bez změněného listu je právě jen přeuspořádání klíčů pravidel', () => {
    const silent = new Set<RepairRule>();
    for (const fixture of fixtures) {
      const report = repairEmission(fixture.body);
      const leaves = changedLeaves(fixture.body, report.document);
      for (const step of report.applied) {
        const touched = leaves.some((leaf) =>
          step.pointers.some((pointer) => leaf === pointer || leaf.startsWith(`${pointer}/`)),
        );
        if (!touched) silent.add(step.rule);
      }
    }
    expect([...silent]).toEqual(['order.rules']);
  });
});

/**
 * Co která emise dostala. Pin proti tichému rozšíření dávky: kdyby opravář začal
 * sahat na něco dalšího, změní se tahle tabulka, ne jen počet.
 */
describe('repairEmission — deklarovaná oprava se provede a nic navíc', () => {
  const EXPECTED: Readonly<Record<string, readonly RepairRule[]>> = {
    M01: ['counter.initFromMin'],
    M02: ['timer.durationFromTier'],
    M04: ['counter.initClamp'],
    M05: ['order.rules'],
    M06: ['order.operands'],
    M07: ['number.fromIntegerString'],
    M08: ['flag.booleanInit'],
    M10: ['rule.unknownField'],
    M12: ['freeze.secondsToTicks'],
    M13: ['timer.secondsToTicks'],
    M16: ['look.orphanModule'],
    M17: ['revision.reset'],
    M19: ['look.systemDefault'],
    M20: ['look.leakedField'],
    M29: ['revision.reset', 'revision.reset'],
  };

  it('tabulka pokrývá právě opravitelné emise', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(repairable.map((fixture) => fixture.id).sort());
  });

  it('každá opravitelná emise dostane právě svou deklarovanou opravu', () => {
    for (const fixture of repairable) {
      const report = repairEmission(fixture.body);
      expect(report.applied.map((step) => step.rule), `${fixture.id}`).toEqual(EXPECTED[fixture.id]);
      expect(report.refused, `${fixture.id}: opravitelná emise nemá co odmítat`).toEqual([]);
    }
  });

  // Odmítnutí je pojmenované, ne mlčení. Jmenují se ty třídy, které opravář
  // doopravdy vidí; zbytek neopravitelných emisí leží mimo jeho dosah.
  it('neopravitelnou vadu, kterou vidí, pojmenuje', () => {
    const kinds = (id: string) => repairEmission(fixtures.find((f) => f.id === id)?.body).refused.map((r) => r.kind);
    expect(kinds('M03')).toContain('dangling.sim');
    expect(kinds('M15')).toContain('dangling.sim');
    expect(kinds('M09')).toEqual(['timer.fractionalDuration']);
    expect(kinds('M27')).toEqual(['counter.unbounded']);
  });
});

/**
 * Větve, které zmrazená sada **nerozliší** — a mutační kontrola to ukázala:
 * dvě záměrné vady sadou nad korpusem prošly zelené.
 *
 * - Pořadí pravidel: `M05` má `win` (fáze 2) a `bump` (fáze 0), takže řazení
 *   podle samotného klíče dá tentýž výsledek jako `(phase, priority, ruleId)`.
 *   Aserce nad `M05` tedy o fázi ani prioritě nic nedokazuje.
 * - Namířenost mazání osiřelého modulu: v korpusu není jméno, které by osiřele
 *   viselo ve `sim` a zároveň bylo klíčem v `look.modules`, takže podmínka na
 *   jmenný prostor nálezu se dá vyhodit a nic nespadne.
 *
 * Fixtury tady jsou proto syntetické schválně a nemají žádnou vazbu na korpus —
 * pokrývají rozhodnutí, ne zmrazený případ.
 */
describe('repairEmission — hranice, které zmrazená sada nerozliší', () => {
  function docOf(sim: Record<string, unknown>, look: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      irVersion: 'v1',
      simRevision: 0,
      lookRevision: 0,
      sim: {
        layout: { kind: 'grid', width: 4, height: 4 },
        grid: { cell: 1 },
        sockets: { s0: [1, 1] },
        collisionAabb: {},
        entities: {},
        rules: {},
        state: {},
        witness: { tier: 'short', ops: [] },
        ...sim,
      },
      look: {
        modules: {},
        palette: 'slate',
        lightRig: 'key',
        atmosphere: 'none',
        materialRoles: {},
        camera: { kind: 'orbit' },
        audio: {},
        ...look,
      },
    };
  }

  const rule = (id: string, phase: number, priority: number) => ({
    id,
    phase,
    priority,
    event: { kind: 'onStart' },
    condition: null,
    actions: [{ kind: 'win' }],
  });

  it('pořadí je (phase, priority, ruleId), ne kterákoli jeho část', () => {
    const report = repairEmission(
      docOf({ rules: { alpha: rule('alpha', 5, 0), beta: rule('beta', 0, 9), zeta: rule('zeta', 0, 1) } }),
    );

    // Rozhodné proti všem třem degenerovaným řazením: podle klíče by vyšlo
    // [alpha, beta, zeta], podle samotné fáze [beta, zeta, alpha], podle samotné
    // priority [alpha, zeta, beta].
    expect(Object.keys(rulesOf(report.document))).toEqual(['zeta', 'beta', 'alpha']);
  });

  it('mazání osiřelého modulu míří do `look.modules`, ne na jméno kdekoli', () => {
    const report = repairEmission(
      docOf(
        { rules: { toggle: { ...rule('toggle', 0, 0), event: { kind: 'onClick', entity: 'lamp' } } } },
        { modules: { lamp: { family: 'fixture' } } },
      ),
    );

    expect(report.refused.map((refusal) => refusal.where)).toEqual(['sim.rules[toggle].event.entity']);
    expect(report.applied.map((step) => step.rule)).toEqual(['look.orphanModule']);
    expect(rec(at(report.document, 'look', 'modules'))).toEqual({});
  });

  it('převádí se jen bezeztrátový celočíselný řetězec', () => {
    for (const threshold of ['03', '3.0', ' 3', '1e3']) {
      const report = repairEmission(
        docOf({
          state: { counters: { n: { min: 0, max: 3, init: 0 } } },
          rules: { win: { ...rule('win', 0, 0), event: { kind: 'onCounterReaches', ref: 'n', threshold } } },
        }),
      );
      expect(report.applied, `threshold ${threshold}`).toEqual([]);
      expect(at(report.document, 'sim', 'rules', 'win', 'event', 'threshold')).toBe(threshold);
    }
  });

  it('freeze, který nevyjde na celý tik, se odmítne a nic nezmění', () => {
    const before = docOf({
      entities: { player: { role: 'actor', socket: 's0', state: 'idle' } },
      rules: {
        stun: { ...rule('stun', 0, 0), actions: [{ kind: 'freeze', target: 'player', seconds: 0.03 }] },
      },
    });
    const report = repairEmission(before);

    expect(report.applied).toEqual([]);
    expect(report.refused.map((refusal) => refusal.kind)).toEqual(['freeze.fractionalTicks']);
    expect(json(report.document)).toBe(json(before));
  });

  it('uniklé pole, které `look` už deklaruje, se nepřesune', () => {
    const before = docOf({ palette: 'amber' });
    const report = repairEmission(before);

    expect(report.applied).toEqual([]);
    expect(report.refused.map((refusal) => refusal.kind)).toEqual(['look.leakedFieldOccupied']);
    expect(at(report.document, 'look', 'palette')).toBe('slate');
    expect(at(report.document, 'sim', 'palette')).toBe('amber');
  });
});

describe('repairEmission — mustPreserve ze zmrazené sady', () => {
  type Check = (before: unknown, after: unknown) => void;

  const sameLeaves = (before: unknown, after: unknown, ...paths: readonly string[]) => {
    for (const path of paths) expect(at(after, ...path.split('.'))).toEqual(at(before, ...path.split('.')));
  };

  const KEEP: Readonly<Record<string, Check>> = {
    'M01::counter.min': (before, after) => sameLeaves(before, after, 'sim.state.counters.score.min'),
    'M01::counter.max': (before, after) => sameLeaves(before, after, 'sim.state.counters.score.max'),
    'M01::pořadí pravidel': (before, after) =>
      expect(Object.keys(rulesOf(after))).toEqual(Object.keys(rulesOf(before))),
    'M01::identita všech stableId': (before, after) =>
      expect(Object.keys(entitiesOf(after))).toEqual(Object.keys(entitiesOf(before))),

    'M02::existence timeru': (before, after) =>
      expect(Object.keys(rec(at(after, 'sim', 'state', 'timers')))).toEqual(
        Object.keys(rec(at(before, 'sim', 'state', 'timers'))),
      ),
    'M02::pravidlo onTimerEnd zůstává navázané na `round`': (before, after) => {
      expect(json(at(after, 'sim', 'rules', 'end'))).toBe(json(at(before, 'sim', 'rules', 'end')));
      expect(at(after, 'sim', 'rules', 'end', 'event', 'timer')).toBe('round');
    },

    'M04::min': (before, after) => sameLeaves(before, after, 'sim.state.counters.keys.min'),
    'M04::max': (before, after) => sameLeaves(before, after, 'sim.state.counters.keys.max'),
    'M04::žádné pravidlo se nesmí přepsat': (before, after) =>
      expect(json(rulesOf(after))).toBe(json(rulesOf(before))),

    'M05::množina pravidel': (before, after) =>
      expect(Object.keys(rulesOf(after)).sort()).toEqual(Object.keys(rulesOf(before)).sort()),
    'M05::phase a priority každého pravidla — smí se změnit jen POŘADÍ klíčů v záznamu': (before, after) => {
      for (const [id, rule] of Object.entries(rulesOf(before))) expect(json(rulesOf(after)[id])).toBe(json(rule));
      // Nové pořadí je to deklarované — a měří ho sdílený oracle z T8b, ne tenhle test.
      expect(Object.keys(rulesOf(after))).toEqual(canonicalRuleOrder(rulesOf(before) as RuleRecord));
      expect(Object.keys(rulesOf(after))).not.toEqual(Object.keys(rulesOf(before)));
    },

    'M06::množina operandů': (before, after) => {
      const operands = (doc: unknown) =>
        (at(doc, 'sim', 'rules', 'open', 'condition', 'operands') as unknown[]).map(json).sort();
      expect(operands(after)).toEqual(operands(before));
    },
    'M06::negace jednotlivých operandů': (before, after) => {
      // Operand se řadí celý, takže `not` nemůže zůstat viset nad jiným uzlem:
      // každý operand po opravě je bitově některý operand před ní.
      const raw = (doc: unknown) => at(doc, 'sim', 'rules', 'open', 'condition', 'operands') as unknown[];
      const source = new Set(raw(before).map(json));
      for (const operand of raw(after)) expect(source.has(json(operand))).toBe(true);
    },

    'M07::hodnota prahu': (before, after) => {
      const path = ['sim', 'rules', 'win', 'event', 'threshold'] as const;
      expect(at(after, ...path)).toBe(Number(at(before, ...path)));
    },
    'M07::typ ostatních polí': (before, after) =>
      expect(changedLeaves(before, after)).toEqual(['/sim/rules/win/event/threshold']),

    'M08::pravdivostní hodnota': (before, after) => {
      const path = ['sim', 'state', 'flags', 'powered', 'init'] as const;
      expect(at(after, ...path)).toBe(Boolean(at(before, ...path)));
    },
    'M08::název flagu': (before, after) =>
      expect(Object.keys(rec(at(after, 'sim', 'state', 'flags')))).toEqual(
        Object.keys(rec(at(before, 'sim', 'state', 'flags'))),
      ),

    'M10::všechna známá pole pravidla beze změny': (before, after) => {
      for (const field of ['id', 'phase', 'priority', 'event', 'condition', 'actions'])
        expect(json(at(after, 'sim', 'rules', 'win', field))).toBe(json(at(before, 'sim', 'rules', 'win', field)));
      expect(changedLeaves(before, after)).toEqual(['/sim/rules/win/comment']);
    },

    'M12::délka zmrazení v reálném čase': (before, after) => {
      const action = (doc: unknown) => rec(at(doc, 'sim', 'rules', 'stun', 'actions', '0'));
      expect((action(after).ticks as number) / TICK_HZ).toBe(action(before).seconds);
      expect(action(after).seconds).toBeUndefined();
    },
    'M12::cíl akce': (before, after) =>
      sameLeaves(before, after, 'sim.rules.stun.actions.0.target'),

    'M13::reálná délka timeru': (before, after) => {
      const timer = (doc: unknown) => rec(at(doc, 'sim', 'state', 'timers', 'flood'));
      expect((timer(after).durationTicks as number) / TICK_HZ).toBe(timer(before).durationSeconds);
      expect(timer(after).durationSeconds).toBeUndefined();
    },
    'M13::pravidla navázaná na timer': (before, after) => expect(json(rulesOf(after))).toBe(json(rulesOf(before))),

    'M16::celá část `sim` bitově beze změny': (before, after) =>
      expect(json(at(after, 'sim'))).toBe(json(at(before, 'sim'))),
    'M16::ostatní moduly v `look`': (before, after) => {
      const modules = (doc: unknown) => rec(at(doc, 'look', 'modules'));
      expect(Object.keys(modules(after))).toEqual(['player']);
      expect(json(modules(after).player)).toBe(json(modules(before).player));
    },

    'M17::lookRevision': (before, after) => sameLeaves(before, after, 'lookRevision'),
    'M17::obsah obou částí': (before, after) => {
      expect(json(at(after, 'sim'))).toBe(json(at(before, 'sim')));
      expect(json(at(after, 'look'))).toBe(json(at(before, 'look')));
    },

    'M19::část `sim` bitově beze změny': (before, after) =>
      expect(json(at(after, 'sim'))).toBe(json(at(before, 'sim'))),
    'M19::simRevision': (before, after) => sameLeaves(before, after, 'simRevision'),

    'M20::hodnota palety': (before, after) => expect(at(after, 'look', 'palette')).toBe(at(before, 'sim', 'palette')),
    'M20::zbytek `sim` bitově beze změny': (before, after) => {
      const stripped = { ...rec(at(before, 'sim')) };
      delete stripped.palette;
      expect(json(at(after, 'sim'))).toBe(json(stripped));
    },

    'M29::obě části bitově beze změny': (before, after) => {
      expect(json(at(after, 'sim'))).toBe(json(at(before, 'sim')));
      expect(json(at(after, 'look'))).toBe(json(at(before, 'look')));
    },
    'M29::nezávislost obou polí — nesmí se sloučit do jednoho': (before, after) => {
      expect(Object.hasOwn(rec(after), 'simRevision')).toBe(true);
      expect(Object.hasOwn(rec(after), 'lookRevision')).toBe(true);
      // Každé pole si srovnal vlastní krok — sloučené by se pohnulo jedním.
      const pointers = repairEmission(before).applied.flatMap((step) => step.pointers);
      expect(pointers).toEqual(['/simRevision', '/lookRevision']);
    },
  };

  it('každá zmrazená fráze má oracle a každý oracle svou frázi', () => {
    const declared = new Set(repairable.flatMap((f) => f.mustPreserve.map((phrase) => `${f.id}::${phrase}`)));
    expect([...declared].filter((key) => !(key in KEEP)), 'fráze bez oracle').toEqual([]);
    expect(Object.keys(KEEP).filter((key) => !declared.has(key)), 'oracle bez fráze v korpusu').toEqual([]);
  });

  it('oprava drží každý slib, který o sobě zmrazená sada dala', () => {
    for (const fixture of repairable) {
      const after = repairEmission(fixture.body).document;
      for (const phrase of fixture.mustPreserve) KEEP[`${fixture.id}::${phrase}`](fixture.body, after);
    }
  });
});
