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
 * hranic světa. Pravidlo rozpouští jméno meze až k jejímu původu a přijímá
 * jediné dva tvary — klesající rozpočet, nebo výraz nad `IrLimits`.
 *
 * **Co pravidlo NEPOKRÝVÁ, a je to tu napsané, ne zamlčené.** Policuje explicitní
 * iterační konstrukce a pole-callbacky. Implicitní iterace zůstávají dvě, obě na
 * tikové cestě a obě ohraničené jinde: `runtime.state.slice()` (délka je layout
 * postavený z deklarovaných slotů a entit) a `new Set(runtime.drainQueue)`
 * (každý `push` do fronty má před sebou test proti `maxQueueDepth`, jinak je to
 * `queue-overflow`). Kdyby některá z těch dvou mezí zmizela, tohle pravidlo to
 * neuvidí.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { IrEffect } from '../../ir/types';
import {
  createRuntime,
  step,
  traceSight,
  type Budget,
  type FaultReason,
  type RunState,
  type Runtime,
  type WorldDocRuntime,
} from '../interpreter';
import { PHASES, phaseBound, type Phase } from '../phases';

import degenerateSightWorld from '../__fixtures__/degenerate-sight.world.json';
import instaWinWorld from '../__fixtures__/insta-win.world.json';
import signalLoopWorld from '../__fixtures__/signal-loop.world.json';
import stateCycleWorld from '../__fixtures__/state-cycle.world.json';
import vaultWorld from '../__fixtures__/vault.world.json';

const vault = vaultWorld as unknown as WorldDocRuntime;
const instaWin = instaWinWorld as unknown as WorldDocRuntime;
const signalLoop = signalLoopWorld as unknown as WorldDocRuntime;
const stateCycle = stateCycleWorld as unknown as WorldDocRuntime;
const degenerateSight = degenerateSightWorld as unknown as WorldDocRuntime;

const WORLDS: readonly (readonly [string, WorldDocRuntime])[] = [
  ['vault', vault],
  ['insta-win', instaWin],
  ['signal-loop', signalLoop],
  ['state-cycle', stateCycle],
  ['degenerate-sight', degenerateSight],
];

const TICK_BUDGET = 60;

// ===========================================================================
// AST pravidlo
// ===========================================================================

const SIM_DIR = join(process.cwd(), 'src', 'sim');

/** Pole `IrLimits`. Mez smí pocházet jen odsud, ne z délky vstupního pole. */
const LIMIT_FIELDS = new Set([
  'maxEntities',
  'maxSlots',
  'maxRules',
  'maxRuleFiringsPerTick',
  'maxQueueDepth',
  'maxAgents',
  'memorySlotsPerAgent',
  'gridWidth',
  'gridHeight',
]);

/** Funkce, které mez z `IrLimits` odvozují. Jiný způsob, jak ji vyrobit, není. */
const BOUND_FUNCTIONS = new Set(['phaseBound', 'pairBound', 'settleItemBound', 'sightBound', 'pathBound']);

/** Iterace bez podmínky. Nemá kam mez napsat, takže je zakázaná na tikové cestě. */
const ARRAY_CALLBACKS = new Set([
  'forEach',
  'map',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'flatMap',
  'reduce',
  'reduceRight',
  'sort',
]);

interface Site {
  readonly module: string;
  readonly fn: string;
  readonly line: number;
  readonly kind: string;
  readonly bounded: boolean;
}

interface SwitchFact {
  readonly module: string;
  readonly fn: string;
  readonly line: number;
  readonly hasNeverDefault: boolean;
}

interface ModuleFacts {
  readonly sites: readonly Site[];
  readonly switches: readonly SwitchFact[];
  readonly calls: ReadonlyMap<string, ReadonlySet<string>>;
  readonly resetBudgetCallers: readonly string[];
}

function enclosingFunction(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    current = current.parent;
  }
  return '<module>';
}

/**
 * Analýza jednoho modulu. Bere text, ne cestu, aby se dala pustit na syntetický
 * zdroj — pravidlo, které nikdo nezkusil shodit, je jen dekorace.
 */
function analyseModule(moduleName: string, source: string): ModuleFacts {
  const sf = ts.createSourceFile(moduleName, source, ts.ScriptTarget.ES2022, true);
  const sites: Site[] = [];
  const switches: SwitchFact[] = [];
  const calls = new Map<string, Set<string>>();
  const resetBudgetCallers: string[] = [];
  const scopes: Map<string, ts.Expression>[] = [new Map()];

  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const lookup = (name: string): ts.Expression | undefined => {
    for (let i = scopes.length - 1; i >= 0; i -= 1) {
      const hit = scopes[i].get(name);
      if (hit) return hit;
    }
    return undefined;
  };

  /**
   * Kolik atomů odvozených z `IrLimits` výraz obsahuje. Není to boolean schválně:
   * `const bound = 5` je taky statická mez, ale ne mez SVĚTA, a tenhle rozdíl je
   * celý smysl pravidla.
   */
  const limitAtoms = (node: ts.Node, depth: number): number => {
    if (depth > 8) return 0;
    if (ts.isParenthesizedExpression(node)) return limitAtoms(node.expression, depth + 1);
    if (ts.isPropertyAccessExpression(node)) return LIMIT_FIELDS.has(node.name.text) ? 1 : 0;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
      return BOUND_FUNCTIONS.has(node.expression.text) ? 1 : 0;
    if (ts.isBinaryExpression(node)) return limitAtoms(node.left, depth + 1) + limitAtoms(node.right, depth + 1);
    if (ts.isPrefixUnaryExpression(node)) return limitAtoms(node.operand, depth + 1);
    if (ts.isIdentifier(node)) {
      const declared = lookup(node.text);
      return declared ? limitAtoms(declared, depth + 1) : 0;
    }
    return 0;
  };

  /** Klesající rozpočet kontrolovaný před každou iterací — druhý povolený tvar. */
  const hasBudgetGuard = (node: ts.Node): boolean => {
    let found = false;
    const visit = (inner: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(inner) &&
        inner.name.text === 'remaining' &&
        inner.expression.getText(sf).includes('budget')
      )
        found = true;
      ts.forEachChild(inner, visit);
    };
    visit(node);
    return found;
  };

  const record = (node: ts.Node, kind: string, condition: ts.Expression | undefined) => {
    const bounded =
      condition !== undefined && (hasBudgetGuard(condition) || limitAtoms(condition, 0) > 0);
    sites.push({ module: moduleName, fn: enclosingFunction(node), line: lineOf(node), kind, bounded });
  };

  const visit = (node: ts.Node): void => {
    const opensScope =
      ts.isBlock(node) || ts.isSourceFile(node) || ts.isForStatement(node) || ts.isCaseBlock(node);
    if (opensScope) scopes.push(new Map());

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer)
          scopes[scopes.length - 1].set(decl.name.text, decl.initializer);
      }
    }

    if (ts.isForStatement(node)) record(node, 'for', node.condition);
    else if (ts.isWhileStatement(node)) record(node, 'while', node.expression);
    else if (ts.isDoStatement(node)) record(node, 'do', node.expression);
    else if (ts.isForOfStatement(node)) record(node, 'for-of', undefined);
    else if (ts.isForInStatement(node)) record(node, 'for-in', undefined);
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ARRAY_CALLBACKS.has(node.expression.name.text)
    )
      record(node, `callback:${node.expression.name.text}`, undefined);

    if (ts.isSwitchStatement(node)) {
      const fallback = node.caseBlock.clauses.find((clause) => ts.isDefaultClause(clause));
      switches.push({
        module: moduleName,
        fn: enclosingFunction(node),
        line: lineOf(node),
        hasNeverDefault: fallback !== undefined && /:\s*never\b/.test(fallback.getText(sf)),
      });
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const caller = enclosingFunction(node);
      if (!calls.has(caller)) calls.set(caller, new Set());
      calls.get(caller)?.add(node.expression.text);
      if (node.expression.text === 'resetBudget') resetBudgetCallers.push(caller);
    }

    ts.forEachChild(node, visit);
    if (opensScope) scopes.pop();
  };

  visit(sf);
  return { sites, switches, calls, resetBudgetCallers };
}

/** `.ts` i `.tsx`, rekurzivně — obojí je díra, kterou kolo 4 review T8b našlo ve skenu zákazu `look`. */
function collectModules(dir: string = SIM_DIR, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__fixtures__') continue;
      found.push(...collectModules(join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(rel);
    }
  }
  return found.sort();
}

function analyseSim(): ModuleFacts {
  const sites: Site[] = [];
  const switches: SwitchFact[] = [];
  const calls = new Map<string, Set<string>>();
  const resetBudgetCallers: string[] = [];
  for (const moduleName of collectModules()) {
    const facts = analyseModule(moduleName, readFileSync(join(SIM_DIR, moduleName), 'utf8'));
    sites.push(...facts.sites);
    switches.push(...facts.switches);
    resetBudgetCallers.push(...facts.resetBudgetCallers);
    for (const [caller, callees] of facts.calls) {
      if (!calls.has(caller)) calls.set(caller, new Set());
      for (const callee of callees) calls.get(caller)?.add(callee);
    }
  }
  return { sites, switches, calls, resetBudgetCallers };
}

/**
 * Tiková cesta = tranzitivní uzávěr volání z `step()`. Rozsah pravidla se tím
 * **počítá**, ne ručně vypisuje: kdyby se zítra dostala konstrukční funkce do
 * tiku, spadne pod tvrdou půlku pravidla sama.
 */
function tickPath(calls: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const reached = new Set<string>(['step']);
  const queue = ['step'];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const callee of calls.get(current) ?? []) {
      if (reached.has(callee)) continue;
      reached.add(callee);
      queue.push(callee);
    }
  }
  return reached;
}

const FACTS = analyseSim();
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

  it('`resetBudget` má v `src/sim/` právě jedno volání a je v `step`', () => {
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

  it('každý `switch` v `src/sim/` končí větví `never`, kterou ověří překladač', () => {
    const leaky = FACTS.switches.filter((entry) => !entry.hasNeverDefault);
    expect(leaky.map((entry) => `${entry.module}:${entry.fn}:${entry.line}`)).toEqual([]);
    expect(FACTS.switches.length).toBeGreaterThan(3);
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
 * Smyčky mimo tikovou cestu. Konstrukce světa, hashování a replay smí růst
 * s dokumentem — přečíst dokument jinak nejde. Práce **na tik** růst nesmí.
 *
 * Seznam je pinutý přesně: nová nezajištěná smyčka se sem nedostane potichu,
 * a kdyby se kterákoli z nich dostala na tikovou cestu, spadne pod tvrdou půlku
 * pravidla dřív, než se sem stihne přidat.
 */
const OFF_TICK_PATH: Readonly<Record<string, number>> = {
  'clock.ts:runTicks': 1, // pumpa tiků, mez je `MAX_CATCHUP_TICKS` v `pump`
  'hash.ts:hashWords': 1, // hash je pozorování stavu, ne krok přechodu
  'interpreter.ts:createRuntime': 4, // stavba layoutu, entit, predikátů a pořadí pravidel
  'interpreter.ts:enumTable': 1, // tabulka symbolů, staví se jednou při konstrukci
  'interpreter.ts:run': 2, // replay driver, mez je argument volajícího
  'rng.ts:createStreams': 1, // čtyři pevné streamy z konstanty
  'state.ts:createState': 1, // počáteční hodnoty layoutu
  'state.ts:defineLayout': 1, // rozvržení slotů ve stavovém poli
};

describe('podmínka 5 — každá smyčka na tikové cestě nese mez v podmínce', () => {
  it('a tiková cesta je počítaná z volání, ne vypsaná ručně', () => {
    // Kdyby se uzávěr nepočítal, tenhle výčet by mlčky vyschnul na `step`.
    for (const fn of ['sense', 'settle', 'applyEffect', 'traceSight', 'isBlocked', 'stepToward'])
      expect(TICK_PATH.has(fn), fn).toBe(true);
    expect(TICK_PATH.has('createRuntime')).toBe(false);
    expect(TICK_PATH.has('run')).toBe(false);
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

  it('klesající rozpočet je druhý povolený tvar', () => {
    const facts = analyseModule(
      'synthetic.ts',
      'function step(r){ while (r.budget.remaining > 0) { r.budget.remaining -= 1; } }',
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
