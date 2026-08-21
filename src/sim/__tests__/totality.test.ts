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

import { buildRuntimeWorld } from '../../ir/build';
import { worldIr } from '../../ir/schema';
import { MAX_OPERANDS, type IrEffect, type IrLimits } from '../../ir/types';
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
import { LIMIT_FIELDS, SCANNED, analyseAll, analyseModule, tickPath, undeclaredTickNames } from './ast-rule';

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

/**
 * Svět, ve kterém je zón **víc než entit**.
 *
 * Bez něj neměří podmínka 4 nad zónami nic: všech šest ručně psaných fixtur má
 * `space.zones` prázdné, takže vnitřní smyčka fáze `sense` v nich nikdy
 * neproběhne a příspěvek `maxEntities * maxZones` v `phaseBound` je v jejich
 * společnosti nezjistitelný. Naměřeno 14. 8. 2026: mutace, která ten příspěvek
 * ze součtu odstranila, přežila celou sadu.
 *
 * Staví se `buildRuntimeWorld`, ne ručně psaným IR — meze pak pocházejí ze
 * stejného místa jako v produkci, a fixtura si je nemůže nastavit pohodlně.
 */
const zoneHeavy = ((): WorldDocRuntime => {
  const built = buildRuntimeWorld({
    layout: { width: 10, height: 6 },
    sockets: { spawn: [1, 3], p1: [3, 3], p2: [5, 3], p3: [7, 3], goal: [9, 3] },
    entities: {
      hero: { role: 'actor', socket: 'spawn', state: 'idle' },
      post: { role: 'goal', socket: 'goal', state: 'idle' },
    },
    state: { counters: {}, flags: {}, timers: {}, zones: { far: [[8, 2, 2, 3]] } },
    rules: {
      done: {
        phase: 0,
        priority: 0,
        event: { kind: 'onEnterZone', entity: 'hero', zone: 'far' },
        condition: null,
        actions: [{ kind: 'win' }],
      },
    },
    witness: { tier: 'short', H_cert: 600, ops: [{ tick: 0, actionId: 'moveTo', target: 'post' }] },
  });
  if (!built.ok) throw new Error(`zone-heavy fixtura se nepostavila: ${built.issues.join('; ')}`);
  if (built.world.ir.limits.maxZones <= built.world.ir.limits.maxEntities)
    throw new Error('zone-heavy fixtura přestala mít víc zón než entit — přestala měřit, co měla');
  return built.world;
})();

const WORLDS: readonly (readonly [string, WorldDocRuntime])[] = [
  ['vault', vault],
  ['insta-win', instaWin],
  ['signal-loop', signalLoop],
  ['state-cycle', stateCycle],
  ['degenerate-sight', degenerateSight],
  ['late-timer', lateTimer],
  ['zone-heavy', zoneHeavy],
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
 * Záměrně částečné přepínače — a **žádný z nich nesmí ležet na tikové cestě**,
 * což hlídá vlastní aserce, ne tenhle komentář.
 *
 * Seznam je **prázdný a je to výsledek, ne opomenutí.** Čtyři výjimky tu byly,
 * všechny ve `validateIrDoc`, a zmizely spolu s celým `ir/schema.ts`: `eval.ts`
 * si `nodeValueKind` bere ze `types.ts`, takže schéma **přestalo být v uzávěru
 * importů tikové cesty**. Není to zeslabení pravidla, je to zúžení jeho rozsahu
 * na to, co replay doopravdy volá — a byl to zároveň důvod téhle změny:
 * `schema.ts` táhne `zod`, a ten skrz verifikátor prosakoval do klientského
 * balíčku. Validátor si vlastní částečné přepínače ponechal, jen je už nikdo
 * nevydává za součást důkazu totality.
 */
const PARTIAL_SWITCHES: readonly string[] = [];

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

  it('a pinutý seznam nesmí krýt přepínač na tikové cestě', () => {
    // Bez téhle aserce se dá díra na tikové cestě zavřít tím, že se dopíše na
    // seznam výjimek — což je přesně to, co se s `nodeValueKind` stalo.
    const onTick = FACTS.switches
      .filter((entry) => !entry.exhaustive && TICK_PATH.has(entry.fn))
      .map((entry) => `${entry.module}:${entry.fn}`);
    expect(onTick).toEqual([]);
    expect(TICK_PATH.has('nodeValueKind')).toBe(true);
  });

  it('vyčerpanost uznává jen `never` větev — návratový typ sám nestačí', () => {
    // Za přepínačem stačí jediný `return` a TS2366 nevznikne; totéž při
    // návratovém typu s `undefined`. Obojí je běžný ČÁSTEČNÝ přepínač.
    const trailing = analyseModule(
      'synthetic.ts',
      'function pick(x: Kind): number { switch (x) { case "a": return 1; case "b": return 2; } return 0; }',
    );
    const optional = analyseModule(
      'synthetic.ts',
      'function pick(x: Kind): number | undefined { switch (x) { case "a": return 1; case "b": return 2; } }',
    );
    const never = analyseModule(
      'synthetic.ts',
      'function pick(x: Kind): number { switch (x) { case "a": return 1; default: { const e: never = x; return e; } } }',
    );
    expect(trailing.switches.map((entry) => entry.exhaustive)).toEqual([false]);
    expect(optional.switches.map((entry) => entry.exhaustive)).toEqual([false]);
    expect(never.switches.map((entry) => entry.exhaustive)).toEqual([true]);
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
  // `ir/schema.ts` tu **byl a přestal být skenovaný**: `eval.ts` si
  // `nodeValueKind` bere ze `types.ts`, takže validátor vypadl z uzávěru importů
  // tikové cesty. Rozsah pravidla se tím zúžil na to, co replay volá — a
  // klientský balíček přestal táhnout `zod`.
  // Snížení myslí postav na sloty a pravidla. Běží jednou při stavbě světa,
  // stejně jako `createRuntime`, a meze má v deklaraci dokumentu: počet myslí a
  // `MAX_AGENT_GOALS` na trasu. Na tikovou cestu se nedostane — interpret o
  // myslích neví, běží pravidla, která z nich vznikla.
  'sim/agents.ts:readMind': 2,
  'sim/agents.ts:lowerMind': 2,
  'sim/agents.ts:expandAgentMinds': 1,
  // Třetí replay driver, vedle `run` a `replayTo`. Mez je počet tiků od
  // volajícího; je to pozorování běhu, ne krok přechodu.
  'sim/agents.ts:visitedZones': 4,
  'sim/clock.ts:runTicks': 1, // pumpa tiků, mez je `MAX_CATCHUP_TICKS` v `pump`
  'sim/hash.ts:hashWords': 1, // hash je pozorování stavu, ne krok přechodu
  'sim/interpreter.ts:createRuntime': 4, // stavba layoutu, entit, predikátů a pořadí pravidel
  'sim/interpreter.ts:enumTable': 1, // tabulka symbolů, staví se jednou při konstrukci
  'sim/interpreter.ts:run': 2, // replay driver, mez je argument volajícího
  'sim/rng.ts:createStreams': 1, // čtyři pevné streamy z konstanty
  'sim/state.ts:createState': 1, // počáteční hodnoty layoutu
  'sim/state.ts:defineLayout': 1, // rozvržení slotů ve stavovém poli
  // Kontroly tvaru světa před odbočením. Běží jednou při větvení, ne v tiku, a
  // meze mají v deklaraci obou porovnávaných dokumentů. Čtyři jména z prostoru
  // jsou lokální funkce uvnitř `sameSpace` — každá pojmenovává tu část, která se
  // hnula, protože „něco v prostoru se změnilo" není odpověď, se kterou se dá
  // něco udělat.
  'sim/rebranch.ts:sameLayout': 1,
  'sim/rebranch.ts:sameSymbols': 2,
  'sim/rebranch.ts:sockets': 2,
  'sim/rebranch.ts:zones': 2,
  'sim/rebranch.ts:blocked': 2,
  'sim/rebranch.ts:tags': 2,
  'sim/timeline.ts:baseFor': 1, // výběr snímku, mez je kapacita kruhu
  'sim/timeline.ts:replayTo': 2, // druhý replay driver, mez je cílový tik od volajícího
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
  /**
   * `LIMIT_FIELDS` je ruční kopie jmen z `IrLimits` a rozejde se s ním tiše.
   *
   * Selhává to v nebezpečném směru: nové pole, které v množině chybí, se za mez
   * neuzná, korektní smyčka spadne jako „nezajištěná" a nejlevnější oprava je mez
   * z podmínky vyhodit. Přesně tuhle situaci vyrobilo přidání `maxZones`
   * (14. 8. 2026), takže se to od té doby kontroluje. Klíče se berou ze
   * **skutečné hodnoty** `IrLimits`, ne z druhého ručního seznamu.
   */
  it('množina polí IrLimits je úplná', () => {
    const limits: IrLimits = {
      maxEntities: 1,
      maxZones: 1,
      maxSlots: 1,
      maxRules: 1,
      maxRuleFiringsPerTick: 1,
      maxQueueDepth: 1,
      maxAgents: 0,
      memorySlotsPerAgent: 0,
      gridWidth: 1,
      gridHeight: 1,
    };
    expect([...Object.keys(limits)].sort()).toEqual([...LIMIT_FIELDS].sort());
  });

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

  it('mez smíchaná s délkou vstupního pole neprojde', () => {
    // Váže řídicí proměnnou, mez je v podmínce — a přesto roste s dokumentem.
    const sum = analyseModule(
      'synthetic.ts',
      'function step(r){ for (let i = 0; i < r.limits.maxSlots + r.doc.slots.length; i += 1) { touch(i); } }',
    );
    const product = analyseModule(
      'synthetic.ts',
      'function step(r){ for (let i = 0; i < r.limits.maxSlots * r.doc.nodes.length; i += 1) { touch(i); } }',
    );
    expect(sum.sites.map((site) => site.bounded)).toEqual([false]);
    expect(product.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('mez propašovaná do argumentu meznové funkce neprojde', () => {
    // Skórovat volání podle jména volaného je táž díra jako sčítání atomů, jen
    // přesunutá ze sčítance do argumentu.
    const raw = analyseModule(
      'synthetic.ts',
      'function step(r){ for (let i = 0; i < sightBound(r.doc.nodes); i += 1) { touch(i); } }',
    );
    const spread = analyseModule(
      'synthetic.ts',
      'function step(r){ for (let i = 0; i < settleItemBound({ ...r.limits, maxSlots: r.doc.slots.length }); i += 1) { touch(i); } }',
    );
    const nested = analyseModule(
      'synthetic.ts',
      'function step(r){ for (let i = 0; i < phaseBound("sense", makeLimits(r.doc)); i += 1) { touch(i); } }',
    );
    expect(raw.sites.map((site) => site.bounded)).toEqual([false]);
    expect(spread.sites.map((site) => site.bounded)).toEqual([false]);
    expect(nested.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('a meznová funkce nad deklarovanými mezemi projde', () => {
    const facts = analyseModule(
      'synthetic.ts',
      'function step(r){ for (let i = 0; i < phaseBound("trigger" satisfies Phase, r.limits); i += 1) { touch(i); } }',
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([true]);
  });

  it('jméno meze na cizím objektu neprojde — kontroluje se i příjemce', () => {
    const facts = analyseModule(
      'synthetic.ts',
      'function step(r){ for (let i = 0; i < r.doc.stats.maxSlots; i += 1) { touch(i); } }',
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('ale čistá aritmetika nad mezemi a konstantami ano', () => {
    const facts = analyseModule(
      'synthetic.ts',
      'function step(r){ for (let i = 0; i < 2 * r.limits.maxSlots + 1; i += 1) { touch(i); } }',
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([true]);
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
 * Mez se pozná jen podle jména, a jméno je slabé ve třech směrech. Všechny tři
 * našlo review nad `dfe727c` a všechny tři mají produkční tvar, ne jen syntetický.
 */
describe('podmínka 5 — jméno meze se dá přebít, a pravidlo to musí poznat', () => {
  it('mez v `let`, kterou pozdější řádek přepíše ze vstupu, neprojde', () => {
    // Reviewer to klasifikoval jako hazard BĚŽNÉHO refaktoru: nevypadá to jako
    // útok, vypadá to jako „ať se větší svět neusekne".
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(r, doc){',
        '  let slotBound = r.limits.maxSlots;',
        '  if (doc.ir.slots.length > slotBound) slotBound = doc.ir.slots.length;',
        '  for (let i = 0; i < slotBound; i += 1) { touch(i); }',
        '}',
      ].join('\n'),
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('lokální `limits` postavený ze vstupu není objekt mezí', () => {
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(runtime, doc){',
        '  const limits = { ...runtime.limits, maxSlots: doc.ir.slots.length };',
        '  for (let i = 0; i < limits.maxSlots; i += 1) { touch(i); }',
        '}',
      ].join('\n'),
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('ani když se přepíše až po deklaraci', () => {
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(runtime, doc){',
        '  let limits = runtime.limits;',
        '  limits = { ...limits, maxSlots: doc.ir.slots.length };',
        '  for (let i = 0; i < limits.maxSlots; i += 1) { touch(i); }',
        '}',
      ].join('\n'),
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('ani když se přepíše destrukturací — je to obyčejný JavaScript, ne trik', () => {
    const array = analyseModule(
      'synthetic.ts',
      [
        'function step(r, doc){',
        '  let slotBound = r.limits.maxSlots;',
        '  [slotBound] = [doc.ir.slots.length];',
        '  for (let i = 0; i < slotBound; i += 1) { touch(i); }',
        '}',
      ].join('\n'),
    );
    const object = analyseModule(
      'synthetic.ts',
      [
        'function step(runtime, doc){',
        '  let limits = runtime.limits;',
        '  ({ limits } = { limits: { ...limits, maxSlots: doc.ir.slots.length } });',
        '  for (let i = 0; i < limits.maxSlots; i += 1) { touch(i); }',
        '}',
      ].join('\n'),
    );
    expect(array.sites.map((site) => site.bounded)).toEqual([false]);
    expect(object.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('stínící parametr se nerozpustí na vnější mez', () => {
    // Extrakce metody si jméno parametru nechává, takže vnější `const bound =
    // limits.maxSlots` zůstane v dosahu a smyčka uvnitř vypadá ohraničeně —
    // přestože volající předává délku vstupního pole.
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(r, doc){',
        '  const bound = r.limits.maxSlots;',
        '  const scan = (bound) => { for (let i = 0; i < bound; i += 1) { touch(i); } };',
        '  scan(doc.ir.slots.length);',
        '  for (let j = 0; j < bound; j += 1) { touch(j); }',
        '}',
      ].join('\n'),
    );
    // Vnější smyčka je pořád ohraničená; stíněná ne.
    expect(facts.sites.map((site) => site.bounded)).toEqual([false, true]);
  });

  it('a stínící destrukturovaná vazba taky ne', () => {
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(r, doc){',
        '  const bound = r.limits.maxSlots;',
        '  function scan(){ const { bound } = doc.ir; for (let i = 0; i < bound; i += 1) { touch(i); } }',
        '  scan();',
        '}',
      ].join('\n'),
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('otrávený `limits` se neschová za neprůhledný parametr', () => {
    // `20b8a56` tenhle tvar odmítalo a `b6cc8c6` ho pustilo — zastavení
    // u neprůhledné vazby je správně pro číselnou mez, ne pro identitu objektu.
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(r, doc){',
        '  const limits = { ...r.limits, maxSlots: doc.ir.slots.length };',
        '  const scan = (limits) => { for (let i = 0; i < limits.maxSlots; i += 1) { touch(i); } };',
        '  scan(limits);',
        '}',
      ].join('\n'),
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('mez schovaná v hlavičce `for` neprojde — je to učebnicový idiom', () => {
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(r, doc){',
        '  const bound = r.limits.maxSlots;',
        '  for (let i = 0, bound = doc.ir.slots.length; i < bound; i += 1) { touch(i); }',
        '}',
      ].join('\n'),
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('ani parametr `catch`, ani parametr šipky se stručným tělem', () => {
    const caught = analyseModule(
      'synthetic.ts',
      [
        'function step(r){',
        '  const bound = r.limits.maxSlots;',
        '  try { risky(); } catch (bound) { for (let i = 0; i < bound; i += 1) { touch(i); } }',
        '}',
      ].join('\n'),
    );
    const concise = analyseModule(
      'synthetic.ts',
      [
        'function step(r, doc){',
        '  const bound = r.limits.maxSlots;',
        '  const scan = (bound) => run(() => { for (let i = 0; i < bound; i += 1) { touch(i); } });',
        '  scan(doc.ir.slots.length);',
        '}',
      ].join('\n'),
    );
    expect(caught.sites.map((site) => site.bounded)).toEqual([false]);
    expect(concise.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('zápis přes `!` nebo `as` je taky zápis', () => {
    const nonNull = analyseModule(
      'synthetic.ts',
      [
        'function step(r, doc){',
        '  let bound = r.limits.maxSlots;',
        '  bound! = doc.ir.slots.length;',
        '  for (let i = 0; i < bound; i += 1) { touch(i); }',
        '}',
      ].join('\n'),
    );
    const asCast = analyseModule(
      'synthetic.ts',
      [
        'function step(r, doc){',
        '  let bound = r.limits.maxSlots;',
        '  (bound as number) = doc.ir.slots.length;',
        '  for (let i = 0; i < bound; i += 1) { touch(i); }',
        '}',
      ].join('\n'),
    );
    expect(nonNull.sites.map((site) => site.bounded)).toEqual([false]);
    expect(asCast.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('verdikt nezávisí na pořadí řádků — odkaz nad deklarací neprojde', () => {
    // `lookup` se plní za průchodu, takže odkaz ležící NAD svou deklarací by
    // spadl do větve „deklarace není vidět, rozhoduje jméno".
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(runtime, doc){',
        '  helper();',
        '  function helper(){ for (let i = 0; i < limits.maxSlots; i += 1) { touch(i); } }',
        '  const limits = { ...runtime.limits, maxSlots: doc.ir.slots.length };',
        '}',
      ].join('\n'),
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('`limits` schované hlouběji v řetězci neprojde — příjemce musí být identifikátor', () => {
    const facts = analyseModule(
      'synthetic.ts',
      'function step(doc){ for (let i = 0; i < doc.userSupplied.limits.maxSlots; i += 1) { touch(i); } }',
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([false]);
  });

  it('ale produkční tvar — destrukturace z runtimu — projde dál', () => {
    // Kdyby neprošel, zpřísnění by mez neutáhlo, jen ji zrušilo.
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(runtime){',
        '  const { doc, limits } = runtime;',
        '  for (let i = 0; i < limits.maxSlots && i < doc.ir.slots.length; i += 1) { touch(i); }',
        '}',
      ].join('\n'),
    );
    expect(facts.sites.map((site) => site.bounded)).toEqual([true]);
  });

  it('a `const limits = runtime.limits` taky', () => {
    const facts = analyseModule(
      'synthetic.ts',
      [
        'function step(runtime){',
        '  const limits = runtime.limits;',
        '  for (let i = 0; i < settleItemBound(limits); i += 1) { touch(i); }',
        '}',
      ].join('\n'),
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
    maxZones: 1,
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

// ===========================================================================
// `fired` — které pravidlo tik doopravdy SPUSTIL
// ===========================================================================

/**
 * `StepResult.fired` je jediná vlastnost běhu, kterou zvenčí nejde dopočítat ze
 * stavu: dva průchody týmž pravidlem umí skončit ve stejném stavu. Čte to
 * `fireCount()` sémantického scoreru (T16), takže obě jeho deklarované meze —
 * pořadí vykonání a prázdno po vadě — musí držet test, ne komentář.
 */
describe('`fired` vykazuje spuštěná pravidla, ne odpálená', () => {
  it('v běžném tiku nese ID pravidel, jejichž efekty proběhly, a nic navíc', () => {
    const known = new Set(vault.ir.rules.map((rule) => rule.ruleId));
    const runtime = createRuntime(vault);
    let seen = 0;

    for (let i = 0; i < TICK_BUDGET && runtime.runState === 'running'; i += 1) {
      const result = step(
        runtime,
        vault.trace.filter((entry) => entry.tick === runtime.tick),
      );
      for (const ruleId of result.fired) expect(known.has(ruleId)).toBe(true);
      seen += result.fired.length;
    }

    // Bez tohohle by test prošel i nad polem, které je pořád prázdné.
    expect(seen).toBeGreaterThan(0);
    expect(runtime.runState).toBe('won');
  });

  it('tik ukončený `runtimeFault` vrací prázdno, i když se před vadou stihly efekty', () => {
    const runtime = createRuntime(signalLoop);
    let lastRunning: readonly string[] = [];

    let result = step(runtime, []);
    for (let i = 0; i < TICK_BUDGET && runtime.runState === 'running'; i += 1) {
      lastRunning = result.fired;
      result = step(runtime, []);
    }

    // Fixture musí doopravdy faultnout, jinak se níž netvrdí nic.
    expect(runtime.runState).toBe('runtimeFault');
    expect(result.fault).toBe('queue-overflow');
    // Vada přijde až na TŘETÍ emisi pravidla, takže dvě předtím proběhly — a
    // přesto se nevykazují: stav se atomicky vrátil na začátek tiku.
    expect(result.fired).toEqual([]);
    // A předchozí, dokončený tik prázdný nebyl — jinak by prázdno nic neznamenalo.
    expect(lastRunning.length).toBeGreaterThan(0);
  });
});
