/**
 * Totalita přechodové funkce — dokázaná KONSTRUKCÍ, ne vzorkováním.
 *
 * `DESIGN-BOOK.md` §6: *„Deterministický simulátor, který se zasekne při
 * zpracování událostí, neověří nic."* Totalita je tvrzení o **všech** vstupech.
 * Dvě patologické fixture a tisíc seedovaných případů ho nedokážou — dokážou jen
 * to, že dva známé případy neselhaly. Proto pět strukturálních podmínek, každá
 * s vlastní kontrolou:
 *
 * 1. monotónní rozpočet · 2. dvojitý buffer front · 3. vyčerpanost přechodů ·
 * 4. ohraničenost fáze zvenčí · 5. ohraničenost primitiva zevnitř
 *
 * Podmínka 5 je **AST pravidlo, ne regex** (upřesnění review P1, kolo 3): regex
 * nad textem je křehký a hlavně neumí dokázat, že mez pochází z deklarovaných
 * hranic světa. Samotný analyzátor i jeho rozsah, včetně toho, co vědomě
 * nepokrývá, jsou v `./ast-rule`.
 */

import { describe, expect, it } from 'vitest';

import { worldIr } from '../../ir/schema';
import { MAX_OPERANDS, type IrEffect } from '../../ir/types';
import {
  createRuntime,
  run,
  step,
  traceSight,
  type Budget,
  type FaultReason,
  type RunState,
  type Runtime,
  type WorldDocRuntime,
} from '../interpreter';
import { PHASES, phaseBound, type Phase } from '../phases';
import { SCANNED, analyseAll, analyseModule, tickPath, undeclaredTickNames } from './ast-rule';

import degenerateSightWorld from '../__fixtures__/degenerate-sight.world.json';
import instaWinWorld from '../__fixtures__/insta-win.world.json';
import lateTimerWorld from '../__fixtures__/late-timer.world.json';
import signalLoopWorld from '../__fixtures__/signal-loop.world.json';
import stateCycleWorld from '../__fixtures__/state-cycle.world.json';
import vaultWorld from '../__fixtures__/vault.world.json';

const vault = vaultWorld as unknown as WorldDocRuntime;
const instaWin = instaWinWorld as unknown as WorldDocRuntime;
const signalLoop = signalLoopWorld as unknown as WorldDocRuntime;
const stateCycle = stateCycleWorld as unknown as WorldDocRuntime;
const degenerateSight = degenerateSightWorld as unknown as WorldDocRuntime;
const lateTimer = lateTimerWorld as unknown as WorldDocRuntime;

const WORLDS: readonly (readonly [string, WorldDocRuntime])[] = [
  ['vault', vault],
  ['insta-win', instaWin],
  ['signal-loop', signalLoop],
  ['state-cycle', stateCycle],
  ['degenerate-sight', degenerateSight],
  ['late-timer', lateTimer],
];

const TICK_BUDGET = 60;

const FACTS = analyseAll(SCANNED);
const TICK_PATH = tickPath(FACTS.calls);

// ===========================================================================
// Podmínka 1 — monotónní rozpočet práce
// ===========================================================================

/** Zaznamená KAŽDÝ zápis do rozpočtu. Zvenčí je vidět jen výsledek, ne průběh. */
function watchBudget(runtime: Runtime): number[] {
  const writes: number[] = [];
  const spy = new Proxy(runtime.budget, {
    set(target, property, value: number) {
      if (property === 'remaining') writes.push(value);
      Reflect.set(target, property, value);
      return true;
    },
  });
  (runtime as { budget: Budget }).budget = spy;
  return writes;
}

describe('podmínka 1 — rozpočet uvnitř tiku jen klesá', () => {
  it('každý tik zapíše nejdřív reset a potom už jen klesající hodnoty', () => {
    const runtime = createRuntime(vault);
    const writes = watchBudget(runtime);
    let ticks = 0;

    for (let i = 0; i < TICK_BUDGET && runtime.runState === 'running'; i += 1) {
      writes.length = 0;
      step(
        runtime,
        vault.trace.filter((entry) => entry.tick === runtime.tick),
      );
      ticks += 1;
      expect(writes[0]).toBe(runtime.limits.maxRuleFiringsPerTick);
      for (let w = 1; w < writes.length; w += 1) {
        expect(writes[w]).toBeLessThan(writes[w - 1]);
      }
    }

    // Bez tohohle by test prošel i nad světem, který se nikdy nerozběhl.
    expect(ticks).toBeGreaterThan(1);
  });

  it('`resetBudget` má ve skenovaných modulech právě jedno volání a je v `step`', () => {
    expect(FACTS.resetBudgetCallers).toEqual(['step']);
  });

  it('a ta kontrola není prázdná — dvě volání ve zdroji ji shodí', () => {
    const twice = analyseModule(
      'synthetic.ts',
      'function step(){ resetBudget(b, l); }\nfunction sneak(){ resetBudget(b, l); }',
    );
    expect(twice.resetBudgetCallers).toEqual(['step', 'sneak']);
  });
});

// ===========================================================================
// Podmínka 2 — dvojitý buffer front
// ===========================================================================

describe('podmínka 2 — fronta ke čtení a fronta k zápisu jsou různé objekty', () => {
  it('emise tiku N nemůže skončit ve frontě, kterou tentýž tik čerpá', () => {
    const runtime = createRuntime(signalLoop);
    const drained = runtime.drainQueue;

    step(runtime, [{ tick: 0, actor: 'hero', actionId: 'use' }]);

    // Kanonický vstup do čerpané fronty patří — je to událost TOHOTO tiku.
    expect(drained).toEqual(['acted(hero,use,none)']);
    // Emise pravidla do ní naopak nesmí; skončila ve druhém bufferu.
    expect(drained).not.toContain('signalled(a)');
    expect(runtime.drainQueue).not.toBe(drained);
    expect(runtime.drainQueue).toEqual(['signalled(a)']);
    expect(runtime.writeQueue).not.toBe(runtime.drainQueue);
    expect(runtime.writeQueue).toEqual([]);
  });

  it('zápisová fronta je po prohození vždy jiný objekt než ta čerpaná', () => {
    const runtime = createRuntime(signalLoop);
    for (let i = 0; i < 3 && runtime.runState === 'running'; i += 1) {
      step(runtime, []);
      expect(runtime.writeQueue).not.toBe(runtime.drainQueue);
    }
  });
});

// ===========================================================================
// Podmínka 3 — vyčerpanost přechodů
// ===========================================================================

/**
 * Záměrně částečné přepínače. Všechny leží ve validátoru dokumentu, ne na tikové
 * cestě, a u každého by `never` větev byla **nepravda**: jejich `default` pokrývá
 * skutečné varianty, ne nemožný zbytek.
 *
 * - `nodeValueKind` — `default` vrací `bool` pro `compare` / `allOf` / `anyOf` /
 *   `not`, což jsou čtyři reálné a všechny boolean varianty
 * - `childIndices` — `default` vrací prázdné pole pro listy, které potomky nemají
 * - `checkFactArgs`, `checkRef`, `validateIrDoc` — validace se úmyslně vyjadřuje
 *   jen k rolím a prostorům, které mají v `world-ir-v1` deklarační tabulku
 */
const PARTIAL_SWITCHES: readonly string[] = [
  'ir/schema.ts:checkFactArgs',
  'ir/schema.ts:checkRef',
  'ir/schema.ts:childIndices',
  'ir/schema.ts:nodeValueKind',
  'ir/schema.ts:validateIrDoc',
];

/** Insta-win se přepíše na prohru, aby byla pozorovatelná i ta výstupní cesta. */
const instaLose: WorldDocRuntime = {
  ...instaWin,
  ir: {
    ...instaWin.ir,
    effects: instaWin.ir.effects.map((effect): IrEffect => (effect.op === 'win' ? { op: 'lose' } : effect)),
  },
};

/** Jedna entita, strop jedna, a pravidlo, které chce spawnovat druhou. */
const entityCap: WorldDocRuntime = {
  ...signalLoop,
  ir: {
    ...signalLoop.ir,
    limits: { ...signalLoop.ir.limits, maxEntities: 1 },
    effects: [{ op: 'spawn', poolTag: 'hero', socket: 's_start', selection: 'lowest-inactive' }],
  },
};

describe('podmínka 3 — každá výstupní cesta `step()` vrací definovaný stav', () => {
  const paths: readonly (readonly [string, WorldDocRuntime, RunState, FaultReason | null])[] = [
    ['běží dál', degenerateSight, 'running', null],
    ['výhra', vault, 'won', null],
    ['prohra', instaLose, 'lost', null],
    ['vyčerpaný rozpočet', stateCycle, 'runtimeFault', 'budget-exhausted'],
    ['přetečení fronty emisí', signalLoop, 'runtimeFault', 'queue-overflow'],
    ['strop entit', entityCap, 'runtimeFault', 'entity-cap'],
  ];

  it.each(paths)('%s', (_label, doc, expected, fault) => {
    const runtime = createRuntime(doc);
    let last = step(runtime, doc.trace.slice());
    for (let i = 0; i < TICK_BUDGET && runtime.runState === 'running'; i += 1) {
      last = step(
        runtime,
        doc.trace.filter((entry) => entry.tick === runtime.tick),
      );
    }
    expect(runtime.runState).toBe(expected);
    expect(runtime.fault).toBe(fault);
    expect(last.iterations).toBeDefined();
    expect(typeof last.tick).toBe('number');
  });

  it('přetečení fronty už na kanonických vstupech je taky definovaná cesta', () => {
    const runtime = createRuntime(signalLoop);
    const overflow = Array.from({ length: signalLoop.ir.limits.maxQueueDepth + 2 }, (_value, i) => ({
      tick: 0,
      actor: 'hero',
      actionId: `a${i}`,
    }));
    const result = step(runtime, overflow);
    expect(result.runState).toBe('runtimeFault');
    expect(result.fault).toBe('queue-overflow');
  });

  it('a `step()` po terminálním stavu nevyhazuje — vrací tentýž stav s nulovými iteracemi', () => {
    for (const [label, doc] of WORLDS) {
      const runtime = createRuntime(doc);
      for (let i = 0; i < TICK_BUDGET && runtime.runState === 'running'; i += 1) {
        step(
          runtime,
          doc.trace.filter((entry) => entry.tick === runtime.tick),
        );
      }
      if (runtime.runState === 'running') continue;
      const after = step(runtime, []);
      expect(after.runState, label).toBe(runtime.runState);
      expect(after.firings, label).toBe(0);
      expect(Object.values(after.iterations).every((count) => count === 0), label).toBe(true);
      expect(() => step(runtime, []), label).not.toThrow();
    }
  });

  it('každý `switch` ve skenovaných modulech je vyčerpaný podle překladače', () => {
    const leaky = FACTS.switches
      .filter((entry) => !entry.exhaustive)
      .map((entry) => `${entry.module}:${entry.fn}`);
    expect(leaky.sort()).toEqual([...PARTIAL_SWITCHES].sort());
    expect(FACTS.switches.length).toBeGreaterThan(3);
  });

  it('a mezi vyčerpanými jsou oba uznávané tvary, ne jen `never` větev', () => {
    // `readRef` vyčerpanost dokazuje návratovým typem; kdyby test uznával jen
    // `never` větev, propustil by ji jako výjimku místo jako důkaz.
    const byReturnType = FACTS.switches.filter((entry) => entry.fn === 'readRef');
    expect(byReturnType.length).toBe(1);
    expect(byReturnType[0].exhaustive).toBe(true);
  });
});

// ===========================================================================
// Podmínka 4 — ohraničenost fáze zvenčí
// ===========================================================================

describe('podmínka 4 — každá fáze zpracuje nejvýš tolik položek, kolik svět deklaruje', () => {
  const seen: Record<Phase, number> = { sense: 0, trigger: 0, apply: 0, settle: 0 };

  it.each(WORLDS)('%s', (_label, doc) => {
    const runtime = createRuntime(doc);
    for (let i = 0; i < TICK_BUDGET && runtime.runState === 'running'; i += 1) {
      const result = step(
        runtime,
        doc.trace.filter((entry) => entry.tick === runtime.tick),
      );
      for (const phase of PHASES) {
        expect(result.iterations[phase]).toBeLessThanOrEqual(phaseBound(phase, runtime.limits));
        seen[phase] = Math.max(seen[phase], result.iterations[phase]);
      }
    }
  });

  it('a žádný čítač nezůstal na nule — jinak by aserce nic neměřila', () => {
    for (const phase of PHASES) expect(seen[phase], phase).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Podmínka 5 — ohraničenost primitiva zevnitř
// ===========================================================================

/**
 * Smyčky mimo tikovou cestu. Konstrukce světa, hashování, validace dokumentu
 * a replay smí růst s dokumentem — přečíst dokument jinak nejde. Práce **na tik**
 * růst nesmí.
 *
 * Seznam je pinutý přesně: nová nezajištěná smyčka se sem nedostane potichu,
 * a kdyby se kterákoli z nich dostala na tikovou cestu, spadne pod tvrdou půlku
 * pravidla dřív, než se sem stihne přidat.
 */
const OFF_TICK_PATH: Readonly<Record<string, number>> = {
  'ir/eval.ts:edgeFires': 1, // vyhledání predikátu; `step` má `predicateIndex`, tudy nejde
  'ir/eval.ts:observationOf': 9, // stavba scény z doménového popisu, mimo tik
  'ir/schema.ts:checkFactArgs': 1, // validace argumentů odvozeného faktu
  'ir/schema.ts:duplicates': 1, // hledání duplicit v deklaracích
  'ir/schema.ts:validateIrDoc': 28, // validace dokumentu — z principu roste s dokumentem
  'sim/clock.ts:runTicks': 1, // pumpa tiků, mez je `MAX_CATCHUP_TICKS` v `pump`
  'sim/hash.ts:hashWords': 1, // hash je pozorování stavu, ne krok přechodu
  'sim/interpreter.ts:createRuntime': 4, // stavba layoutu, entit, predikátů a pořadí pravidel
  'sim/interpreter.ts:enumTable': 1, // tabulka symbolů, staví se jednou při konstrukci
  'sim/interpreter.ts:run': 2, // replay driver, mez je argument volajícího
  'sim/rng.ts:createStreams': 1, // čtyři pevné streamy z konstanty
  'sim/state.ts:createState': 1, // počáteční hodnoty layoutu
  'sim/state.ts:defineLayout': 1, // rozvržení slotů ve stavovém poli
};

describe('podmínka 5 — rozsah pravidla je tiková cesta, ne adresář', () => {
  it('modul, do kterého tik vystupuje z `src/sim/`, je skenovaný', () => {
    // Tohle je ta konkrétní díra: `evalNode` byl na tikové cestě a jeho `.every`
    // nad operandy vstupního dokumentu pravidlo nikdy nevidělo.
    expect(SCANNED).toContain('ir/eval.ts');
    expect(TICK_PATH.has('evalNode')).toBe(true);
    expect(FACTS.sites.filter((site) => site.module === 'ir/eval.ts').length).toBeGreaterThan(0);
  });

  it('každé jméno na tikové cestě má deklaraci ve skenovaných modulech', () => {
    expect(undeclaredTickNames(FACTS.declared, TICK_PATH)).toEqual([]);
  });

  it('a ta kontrola není prázdná — volání do neskenovaného modulu ji shodí', () => {
    const facts = analyseModule('synthetic.ts', 'function step(r){ outsider(r); }');
    expect(undeclaredTickNames(facts.declared, tickPath(facts.calls))).toEqual(['outsider']);
  });

  it('a tiková cesta je počítaná z volání, ne vypsaná ručně', () => {
    // Kdyby se uzávěr nepočítal, tenhle výčet by mlčky vyschnul na `step`.
    for (const fn of ['sense', 'settle', 'applyEffect', 'traceSight', 'isBlocked', 'stepToward', 'evalBool'])
      expect(TICK_PATH.has(fn), fn).toBe(true);
    expect(TICK_PATH.has('createRuntime')).toBe(false);
    expect(TICK_PATH.has('run')).toBe(false);
  });
});

describe('podmínka 5 — každá smyčka na tikové cestě nese mez v podmínce', () => {
  it('žádná nezajištěná smyčka na tikové cestě', () => {
    const violations = FACTS.sites
      .filter((site) => !site.bounded && TICK_PATH.has(site.fn))
      .map((site) => `${site.module}:${site.fn}:${site.line} (${site.kind})`);
    expect(violations).toEqual([]);
  });

  it('a smyčky mimo tikovou cestu sedí na pinutém seznamu', () => {
    const counted: Record<string, number> = {};
    for (const site of FACTS.sites) {
      if (site.bounded || TICK_PATH.has(site.fn)) continue;
      const key = `${site.module}:${site.fn}`;
      counted[key] = (counted[key] ?? 0) + 1;
    }
    expect(counted).toEqual(OFF_TICK_PATH);
  });

  it('pravidlo shodí nezajištěnou smyčku na tikové cestě — ověřeno mutací', () => {
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(r){ sense(r); }',
        'function sense(r){ const bound = r.items.length; for (let i = 0; i < bound; i += 1) { touch(i); } }',
      ].join('\n'),
    );
    const path = tickPath(facts.calls);
    const violations = facts.sites.filter((site) => !site.bounded && path.has(site.fn));
    expect(violations.map((site) => site.fn)).toEqual(['sense']);
  });

  it('a tutéž smyčku s mezí ze světa propustí', () => {
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(r){ sense(r); }',
        'function sense(r){ const bound = r.limits.maxEntities; for (let i = 0; i < bound && i < r.items.length; i += 1) { touch(i); } }',
      ].join('\n'),
    );
    expect(facts.sites.every((site) => site.bounded)).toBe(true);
  });

  it('statická mez, která NENÍ z mezí světa, neprojde', () => {
    const facts = analyseModule('synthetic.ts', 'function step(){ for (let i = 0; i < 64; i += 1) { touch(i); } }');
    expect(facts.sites.every((site) => site.bounded)).toBe(false);
  });

  it('iterace bez podmínky neprojde ani jako `for…of`, ani jako `forEach`', () => {
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(r){ for (const item of r.items) { touch(item); } }',
        'function other(r){ r.items.forEach((item) => touch(item)); }',
      ].join('\n'),
    );
    expect(facts.sites.map((site) => `${site.kind}:${String(site.bounded)}`)).toEqual([
      'for-of:false',
      'callback:forEach:false',
    ]);
  });

  it('mez schovaná za `break` uvnitř těla neprojde — musí být v podmínce', () => {
    const facts = analyseModule(
      'synthetic.ts',
      'function step(r){ while (true) { if (i > r.limits.maxEntities) break; touch(i); } }',
    );
    expect(facts.sites.every((site) => site.bounded)).toBe(false);
  });
});

/**
 * Tohle je půlka pravidla, kterou review nad `1afb764` prostřelilo: `bounded`
 * znamenalo „v podmínce se někde vyskytuje jméno meze", ne „mez omezuje řídicí
 * proměnnou". Rozdíl je pozorovatelný jen na těchhle tvarech — v produkčním kódu
 * dávala obě čtení stejný verdikt, a proto to nespadlo.
 */
describe('podmínka 5 — mez musí OMEZOVAT, ne se jen vyskytovat', () => {
  it('jméno meze vedle iterace přes vstupní dokument neprojde', () => {
    const facts = analyseModule(
      'synthetic.ts',
      'function step(r){ for (let i = 0; i < r.doc.slots.length && r.limits.maxSlots > 0; i += 1) { touch(i); } }',
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('mez na jiné proměnné než na té řídicí neprojde', () => {
    // Mez je v podmínce a je to skutečná mez světa — jen nesvazuje `i`.
    const facts = analyseModule(
      'synthetic.ts',
      'function step(r, k){ for (let i = 0; i < r.items.length && k < r.limits.maxEntities; i += 1) { touch(i); } }',
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('obrácená orientace porovnání projde, když váže řídicí proměnnou', () => {
    const facts = analyseModule(
      'synthetic.ts',
      'function step(r){ for (let i = 0; r.limits.maxEntities > i; i += 1) { touch(i); } }',
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([true]);
  });

  it('klesající rozpočet je druhý povolený tvar', () => {
    const facts = analyseModule(
      'synthetic.ts',
      'function step(r){ while (r.budget.remaining > 0) { r.budget.remaining -= 1; } }',
    );
    expect(facts.sites.every((site) => site.bounded)).toBe(true);
  });

  it('rozpočet bez odečtení v těle neprojde — porovnání by nikdy nepřestalo platit', () => {
    const facts = analyseModule(
      'synthetic.ts',
      'function step(r, q){ while (q.length > 0 && r.budget.remaining >= 0) { touch(q); } }',
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('zmíněný rozpočet bez porovnání taky ne', () => {
    const facts = analyseModule(
      'synthetic.ts',
      'function step(r, q){ while (q.length > 0) { r.budget.remaining -= 1; } }',
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('a `--` se počítá jako odečtení stejně jako `-= 1`', () => {
    const facts = analyseModule(
      'synthetic.ts',
      'function step(r){ while (r.budget.remaining > 0) { r.budget.remaining--; } }',
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([true]);
  });
});

/**
 * Mez `MAX_OPERANDS` je třetí povolený původ — ale jen proto, že ji **vynucuje
 * schéma**. Kdyby ji schéma nevynutilo, byla by to konstanta v podmínce smyčky,
 * která o vstupním dokumentu netvrdí nic, a `evalNode` by prostě tiše zahodil
 * operandy nad stropem.
 */
describe('podmínka 5 — mez sdílená se zod schématem je skutečně sdílená', () => {
  const LIMITS = {
    maxEntities: 1,
    maxSlots: 1,
    maxRules: 1,
    maxRuleFiringsPerTick: 1,
    maxQueueDepth: 1,
    maxAgents: 0,
    memorySlotsPerAgent: 0,
    gridWidth: 1,
    gridHeight: 1,
  };

  const docWithOperands = (count: number) => {
    const operands = Array.from({ length: count }, (_value, i) => i);
    return {
      irVersion: 'world-ir-v1',
      limits: LIMITS,
      slots: [],
      entities: [],
      nodes: [...operands.map(() => ({ kind: 'literal', value: true })), { kind: 'allOf', operands }],
      predicates: [],
      effects: [],
      rules: [],
    };
  };

  it('schéma přijme právě `MAX_OPERANDS` operandů', () => {
    expect(worldIr.safeParse(docWithOperands(MAX_OPERANDS)).success).toBe(true);
  });

  it('a o jeden víc odmítne — tím je mez v podmínce smyčky vynutitelná', () => {
    expect(worldIr.safeParse(docWithOperands(MAX_OPERANDS + 1)).success).toBe(false);
  });

  it('smyčka s mezí ze schématu projde, s cizí konstantou ne', () => {
    const shared = analyseModule(
      'synthetic.ts',
      'function step(n){ for (let i = 0; i < MAX_OPERANDS && i < n.operands.length; i += 1) { touch(i); } }',
    );
    const foreign = analyseModule(
      'synthetic.ts',
      'function step(n){ for (let i = 0; i < MAX_WHATEVER && i < n.operands.length; i += 1) { touch(i); } }',
    );
    expect(shared.sites.map((site) => site.bounded)).toEqual([true]);
    expect(foreign.sites.map((site) => site.bounded)).toEqual([false]);
  });
});

describe('podmínka 5 — degenerovaný paprsek vrací v jedné iteraci', () => {
  const space = degenerateSight.space;
  const limits = degenerateSight.ir.limits;

  it('dvě entity ve stejné kvantované buňce stojí jednu iteraci', () => {
    expect(traceSight(space, limits, 2, 2, 2, 2)).toEqual({ visible: true, steps: 1 });
  });

  it('a nedegenerovaný paprsek jich stojí víc — jinak by ta jednička nic neznamenala', () => {
    expect(traceSight(space, limits, 0, 0, 3, 3).steps).toBeGreaterThan(1);
  });

  it('průchod mřížkou nikdy nepřekročí `sightBound`', () => {
    const bound = limits.gridWidth + limits.gridHeight;
    for (let x = 0; x < limits.gridWidth; x += 1) {
      for (let y = 0; y < limits.gridHeight; y += 1) {
        expect(traceSight(space, limits, 0, 0, x, y).steps).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('svět s degenerovaným `onSeen` odkrokuje a pravidlo spustí', () => {
    const runtime = createRuntime(degenerateSight);
    const result = step(runtime, []);
    expect(result.runState).toBe('running');
    expect(result.fault).toBeNull();
    expect(result.iterations.apply).toBeGreaterThan(0);
  });
});

/**
 * Mez smyčky musí být z domény, kterou smyčka prochází.
 *
 * Časovače jsou sloty, ale mez byla `maxEntities + maxQueueDepth`. Svět s jednou
 * entitou a časovačem za tím řezem svůj časovač **nikdy nesnížil**: tik dál
 * terminoval, žádný fault se nevyhlásil, `onTimerEnd` prostě nikdy nenastalo.
 * Tichý soft-lock je horší než pád — pád je pozorovatelný.
 */
describe('mez fáze `settle` je z domény smyčky, ne z té sousední', () => {
  it('časovač za mezí odvozenou z entit se snižuje a pravidlo spustí', () => {
    const runtime = createRuntime(lateTimer);
    expect(run(runtime, TICK_BUDGET)).toBe('won');
    expect(runtime.tick).toBe(lateTimer.winsAtTick);
  });

  it('a leží skutečně za tou původní mezí — jinak by fixture nic nedokazovala', () => {
    const limits = lateTimer.ir.limits;
    const timerIndex = lateTimer.ir.slots.findIndex((slot) => slot.space === 'timer');
    expect(timerIndex).toBeGreaterThanOrEqual(limits.maxEntities + limits.maxQueueDepth);
    expect(timerIndex).toBeLessThan(limits.maxSlots);
  });

  it('fáze `settle` zůstává ohraničená deklarovanými mezemi', () => {
    const runtime = createRuntime(lateTimer);
    for (let i = 0; i < TICK_BUDGET && runtime.runState === 'running'; i += 1) {
      const result = step(runtime, []);
      expect(result.iterations.settle).toBeLessThanOrEqual(phaseBound('settle', runtime.limits));
      expect(result.iterations.settle).toBeGreaterThan(0);
    }
  });
});
