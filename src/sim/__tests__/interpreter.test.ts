import { describe, expect, it } from 'vitest';

import type { IrEffect } from '../../ir/types';
import { hashHex } from '../hash';
import {
  createRuntime,
  isInstaWin,
  run,
  step,
  type RunState,
  type WorldDocRuntime,
} from '../interpreter';
import { readSlot } from '../state';

import { oscillator } from '../__fixtures__/oscillator';
import instaWinWorld from '../__fixtures__/insta-win.world.json';
import signalLoopWorld from '../__fixtures__/signal-loop.world.json';
import stateCycleWorld from '../__fixtures__/state-cycle.world.json';
import vaultWorld from '../__fixtures__/vault.world.json';

const vault = vaultWorld as unknown as WorldDocRuntime;
const instaWin = instaWinWorld as unknown as WorldDocRuntime;
const signalLoop = signalLoopWorld as unknown as WorldDocRuntime;
const stateCycle = stateCycleWorld as unknown as WorldDocRuntime;

/** Rozpočet tiků je společný pro běh i pro kontrafaktuál — jinak by rozdíl nic neznamenal. */
const TICK_BUDGET = 60;

function replay(doc: WorldDocRuntime, maxTicks = TICK_BUDGET): { runState: RunState; tick: number; hash: string } {
  const runtime = createRuntime(doc);
  const runState = run(runtime, maxTicks);
  return { runState, tick: runtime.tick, hash: hashHex(runtime.state) };
}

describe('replay zaznamenané stopy', () => {
  it('dojde do výhry v zaznamenaném tiku', () => {
    const outcome = replay(vault);
    expect(outcome.runState).toBe('won');
    expect(outcome.tick).toBe(vault.winsAtTick);
  });

  it('dva běhy se stejným světem dají identický hash', () => {
    expect(replay(vault).hash).toBe(replay(vault).hash);
  });

  /**
   * Kontrafaktuál, ne časové pořadí.
   *
   * Review v2 (Q2/T8): `winFiredAtTick > causeStepTick` dokazuje jen to, že
   * výhra přišla později — vyvolat ji mohl nezávislý časovač. Teprve odebrání
   * příčinného vstupu odliší příčinu od koincidence, a rozpočet tiků musí
   * zůstat týž, jinak se testuje jen kratší běh.
   */
  it('bez příčinného vstupu výhra ve stejném rozpočtu tiků nenastane', () => {
    const withoutCause: WorldDocRuntime = { ...vault, trace: [] };
    const outcome = replay(withoutCause);
    expect(outcome.runState).toBe('running');
  });

  it('odebrání příčiny mění výsledek, ne jen rychlost — stopa má právě jeden vstup', () => {
    // Kdyby stopa nesla vstupů víc, „odebrali jsme příčinu" by bylo tvrzení o
    // celé stopě, ne o příčině.
    expect(vault.trace).toHaveLength(1);
  });
});

describe('svět vyhraný už při setupu', () => {
  it('je odmítnut', () => {
    expect(isInstaWin(instaWin)).toBe(true);
  });

  it('a poctivý svět odmítnut není — jinak by kontrola vracela pořád totéž', () => {
    expect(isInstaWin(vault)).toBe(false);
  });
});

/**
 * `runtimeFault` je **definovaný přechod runtimu**, ne výjimka. Rozdíl je
 * pozorovatelný: po výjimce nezbyde stav, který by šlo replaynout, kdežto po
 * `runtimeFault` se svět dál dá krokovat a vrací tentýž stav.
 */
describe('runtimeFault je zotavitelný stav, ne výjimka', () => {
  const faults: readonly (readonly [string, WorldDocRuntime, string])[] = [
    ['přetečení fronty u signálové smyčky', signalLoop, 'queue-overflow'],
    ['vyčerpání rozpočtu u cyklu stavů', stateCycle, 'budget-exhausted'],
  ];

  it.each(faults)('%s skončí v runtimeFault', (_label, doc, reason) => {
    const runtime = createRuntime(doc);
    run(runtime, TICK_BUDGET);
    expect(runtime.runState).toBe('runtimeFault');
    expect(runtime.fault).toBe(reason);
  });

  it.each(faults)('%s: step() po pádu nevyhazuje a vrací definovaný stav', (_label, doc) => {
    const runtime = createRuntime(doc);
    run(runtime, TICK_BUDGET);
    const after = step(runtime, []);
    expect(after.runState).toBe('runtimeFault');
    expect(after.fault).not.toBeNull();
    expect(() => step(runtime, [])).not.toThrow();
  });

  it('pád tik ATOMICKY přeruší — stav se vrátí na začátek tiku', () => {
    const runtime = createRuntime(stateCycle);
    const before = hashHex(runtime.state);
    run(runtime, TICK_BUDGET);
    expect(runtime.runState).toBe('runtimeFault');
    // Poloviční tik by tady nechal dva ze tří přepnutých stavů.
    expect(hashHex(runtime.state)).toBe(before);
  });
});

/**
 * Dvojitý buffer front je to, co `onSignal(A) → emit(A)` znemožňuje
 * strukturálně: `A` vložené během tiku fyzicky nemůže skončit ve frontě, kterou
 * tentýž tik dočerpává. Pozoruje se to na tom, že se emise doručí až o tik dál.
 */
describe('odvozené události se doručují až v příštím tiku', () => {
  it('signál emitovaný v tiku N se čerpá v tiku N+1', () => {
    const runtime = createRuntime(signalLoop);
    expect(runtime.drainQueue).toEqual([]);
    step(runtime, []);
    // `r.kick` emitoval; fronta ke čtení se naplnila až prohozením na konci tiku.
    expect(runtime.drainQueue).toEqual(['signalled(a)']);
    expect(runtime.writeQueue).toEqual([]);
  });
});

describe('pořadí vykonání pravidel je explicitní', () => {
  it('řadí se podle (fáze, priorita, ruleId), ne podle pořadí v dokumentu', () => {
    const runtime = createRuntime(stateCycle);
    expect(runtime.ruleOrder.map((rule) => rule.ruleId)).toEqual([
      'r.ea.up',
      'r.ea.down',
      'r.eb.up',
      'r.eb.down',
      'r.ec.up',
      'r.ec.down',
    ]);
  });

  it('přeuspořádání dokumentu pořadí vykonání nezmění', () => {
    const shuffled: WorldDocRuntime = {
      ...stateCycle,
      ir: { ...stateCycle.ir, rules: [...stateCycle.ir.rules].reverse() },
    };
    expect(createRuntime(shuffled).ruleOrder.map((rule) => rule.ruleId)).toEqual(
      createRuntime(stateCycle).ruleOrder.map((rule) => rule.ruleId),
    );
  });
});

/**
 * Kauzální stopa **vedle** stavu: co které spuštěné pravidlo zapsalo. Sbírá se
 * jen ve fázi 3, takže `after` je hodnota po efektu, ne po `settle` — a nikdy
 * nesahá na hashovaný stav, což pinuje běh se záznamem proti běhu bez něj.
 */
describe('vysvětlení tiku — co které pravidlo zapsalo', () => {
  /** Svět ze `signalLoop`, ve kterém `r.kick` při startu provede zadané efekty. */
  function kickWorld(effects: IrEffect[], overrides: Partial<WorldDocRuntime['ir']> = {}, space = signalLoop.space): WorldDocRuntime {
    return {
      ...signalLoop,
      space,
      ir: { ...signalLoop.ir, ...overrides, effects, rules: [{ ...signalLoop.ir.rules[0], effects: effects.map((_effect, i) => i) }] },
    };
  }

  it('`assign` a `addCounter` nesou před/po v pořadí efektů', () => {
    const runtime = createRuntime(vault);
    step(runtime, []);
    step(runtime, []);
    const pulled = step(runtime, vault.trace);
    expect(pulled.explain).toEqual([
      {
        ruleId: 'r.pull',
        predicate: 'p.onAction.hero.pull.lever',
        guardHeld: true,
        writes: [
          { slot: 'f:unlocked', before: 0, after: 1 },
          { slot: 'c:keys', before: 0, after: 1 },
        ],
      },
    ]);
    // Emise do fronty není zápis slotu — pravidlo je ve stopě, zápisy prázdné.
    expect(step(runtime, []).explain).toEqual([
      { ruleId: 'r.threshold', predicate: 'p.onCounterReaches.keys.1', guardHeld: true, writes: [] },
    ]);
  });

  it('pravidlo, jehož hrana nastala a stráž neprošla, je ve stopě se `guardHeld: false`', () => {
    // `r.pull` bez `assign unlocked` — signál `open` dorazí, ale stráž `r.open` padne.
    const noUnlock: WorldDocRuntime = {
      ...vault,
      ir: { ...vault.ir, rules: vault.ir.rules.map((rule) => (rule.ruleId === 'r.pull' ? { ...rule, effects: [1] } : rule)) },
    };
    const runtime = createRuntime(noUnlock);
    run(runtime, 4);
    const result = step(runtime, []);
    expect(result.fired).toEqual([]);
    expect(result.explain).toEqual([{ ruleId: 'r.open', predicate: 'p.onSignal.open', guardHeld: false, writes: [] }]);
    expect(runtime.runState).toBe('running');
  });

  it('`startTimer` zapíše dobu — a `after` je hodnota z fáze 3, ne po `settle`', () => {
    const runtime = createRuntime(
      kickWorld([{ op: 'startTimer', slot: 'fuse', durationTicks: 5 }], {
        slots: [{ space: 'timer', id: 'fuse', maxTicks: 16, initial: 0 }],
      }),
    );
    const result = step(runtime, []);
    expect(result.explain).toEqual([
      { ruleId: 'r.kick', predicate: 'p.onStart', guardHeld: true, writes: [{ slot: 't:fuse', before: 0, after: 5 }] },
    ]);
    expect(readSlot(runtime.layout, runtime.state, 't:fuse')).toBe(4);
  });

  it('`spawn` zapíše aktivaci i obě souřadnice soketu', () => {
    const runtime = createRuntime(
      kickWorld(
        [
          { op: 'despawn', entity: 'hero' },
          { op: 'spawn', poolTag: 'hero', socket: 's_far', selection: 'lowest-inactive' },
        ],
        {},
        { ...signalLoop.space, sockets: { s_start: [0, 0], s_far: [2, 3] } },
      ),
    );
    expect(step(runtime, []).explain[0].writes).toEqual([
      { slot: 'e:hero:active', before: 1, after: 0 },
      { slot: 'e:hero:active', before: 0, after: 1 },
      { slot: 'e:hero:x', before: 0, after: 2 },
      { slot: 'e:hero:y', before: 0, after: 3 },
    ]);
  });

  it('tik ukončený `runtimeFault` vrací prázdnou stopu — stav se vrátil', () => {
    const budget = createRuntime(stateCycle);
    run(budget, TICK_BUDGET);
    expect(budget.runState).toBe('runtimeFault');
    expect(step(budget, []).explain).toEqual([]);

    const overflow = createRuntime(signalLoop);
    expect(step(overflow, []).explain).toHaveLength(1);
    const faulted = step(overflow, []);
    expect(faulted.fault).toBe('queue-overflow');
    expect(faulted.explain).toEqual([]);
  });

  it('pin: hash stavu po 400 ticích se záznamem se rovná hashi bez záznamu', () => {
    const recorded = createRuntime(oscillator());
    const silent = createRuntime(oscillator());
    silent.explain = false;
    let writes = 0;
    for (let i = 0; i < 400; i += 1) {
      const result = step(recorded, []);
      for (const firing of result.explain) writes += firing.writes.length;
      expect(step(silent, []).explain).toEqual([]);
    }
    expect(recorded.tick).toBe(400);
    expect(hashHex(recorded.state)).toBe(hashHex(silent.state));
    // Bez tohohle by pin prošel i nad světem, kde se nikdy nic nezapsalo.
    expect(writes).toBeGreaterThan(100);
  });
});
