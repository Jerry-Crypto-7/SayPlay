/**
 * Stav a průchody logiky v jádře (P45B T4): časovač doběhne přesně v tiku start + n, přechod
 * fází vystřelí výstup i vstup jednou, událost nikdy dvakrát, kruh událostí neuvízne, spawn
 * nepřepíše logické tělo a dva běhy dají stejný hash. Kusy pravidel jsou testovací – jazyk
 * pravidel je na kusy snižuje až v T5.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  type ArcadeEffect,
  type ArcadeLevel,
  type ArcadeWorld,
  BODY,
  type BodyInit,
  type ControlPiece,
  FIRED,
  FLAG,
  HEADER,
  LOGIC_BODIES,
  LOGIC_SLOTS,
  NO_INPUT,
  ROLE,
  type RulePiece,
  type RuleTrigger,
  bodyBase,
  firedBit,
  logicBase,
  phaseOf,
  timerLeft,
  varValue,
} from '../contract';
import { type ArcadeLibrary, type LogicInit, buildWorld, hashArcade, instantiate, loadProgram, replay, step } from '../kernel';

const still: ControlPiece<Record<string, never>> = {
  id: 'still',
  params: z.object({}),
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: () => undefined,
};

interface Params {
  readonly at: number;
  readonly effects: readonly ArcadeEffect[];
}

/** Testovací pravidlo: na spouštěči `trigger` vydá `effects`, když `when` platí. */
function piece(id: string, trigger: RuleTrigger, when: (state: Int32Array, at: number) => boolean): RulePiece<Params> {
  return {
    id,
    trigger,
    params: z.custom<Params>(),
    roles: [],
    cost: () => ({ bodies: 0, rules: 1 }),
    fire: (ctx, params) => (when(ctx.state, params.at) ? params.effects : []),
  };
}

const library: ArcadeLibrary = {
  controls: { still },
  rules: {
    at_tick: piece('at_tick', 'tick', (state, at) => state[HEADER.tick] === at),
    on_timer: piece('on_timer', 'timer', (state, at) => firedBit(state, logicBase(state), FIRED.timer + at)),
    on_enter: piece('on_enter', 'phase', (state, at) => firedBit(state, logicBase(state), FIRED.phaseEnter + at)),
    on_exit: piece('on_exit', 'phase', (state, at) => firedBit(state, logicBase(state), FIRED.phaseExit + at)),
    on_event: piece('on_event', 'event', (state, at) => firedBit(state, logicBase(state), FIRED.event + at)),
  },
  generators: {},
  bots: { idle: { id: 'idle', params: z.object({}), roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT } },
};

type Rule = readonly [id: string, at: number, effects: readonly ArcadeEffect[]];

const player: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 600, h: 1600, d: 500, solid: false };
/** Předloha spawnu daleko od hráče – nic se ničeho nedotkne. */
const template: BodyInit = { role: 'collectible', kind: 'coin', x: 50_000, y: 0, z: 50_000, w: 500, h: 500, d: 500, solid: false };

function world(rules: readonly Rule[], logic: LogicInit | undefined, spawnSlots = 0): ArcadeWorld {
  const level: ArcadeLevel = { bodies: [player, template], length: 100_000, spawnSlots };
  const built = buildWorld(
    { seed: 1, control: { id: 'still', params: {} }, rules: rules.map(([id, at, effects]) => ({ id, params: { at, effects } })), bot: { id: 'idle', params: {} }, level, ...(logic === undefined ? {} : { logic }) },
    library,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const vars8 = (state: Int32Array): number[] => Array.from({ length: 8 }, (_, i) => varValue(state, logicBase(state), i));

/** Pustí `ticks` tiků; `history[t]` = proměnné po tiku `t`. `pause` čeká mezi tiky (ms). */
function run(w: ArcadeWorld, ticks: number, pause = 0) {
  const state = instantiate(w);
  const program = loadProgram(w, library);
  const history: number[][] = [];
  const traced: string[] = [];
  for (let t = 0; t < ticks; t += 1) {
    step(state, NO_INPUT, program, (_rule, effect) => traced.push(`${String(t)} ${JSON.stringify(effect)}`));
    history.push(vars8(state));
    if (pause > 0) {
      const until = performance.now() + pause;
      while (performance.now() < until) {
        // Čeká naschvál: jádro nesmí vidět hodiny.
      }
    }
  }
  return { state, history, traced };
}

/** Tiky, ve kterých se proměnná `index` změnila. */
const changedAt = (history: readonly number[][], index: number): number[] =>
  history.flatMap((vars, t) => ((vars[index] as number) !== ((t === 0 ? 0 : history[t - 1]?.[index]) as number) ? [t] : []));

const add = (v: number, amount = 1): ArcadeEffect => ({ kind: 'addVar', var: v, amount });

describe('logic bodies and the arcade-v3 stamp', () => {
  it('a world without logic has no logic bodies and stays arcade-v2', () => {
    const w = world([], undefined);
    expect(w.runtimeVersion).toBe('arcade-v2');
    expect('logic' in w).toBe(false);
    expect(w.initial[HEADER.bodyCount]).toBe(2);
    expect(w.initial[HEADER.spawnBase]).toBe(2);
  });

  it('a world with logic gets two dead, sizeless logic bodies under spawnBase and arcade-v3', () => {
    const w = world([], { vars: [7, 0, 0, 0, 0, 0, 0, -3], phases: 2 });
    expect(w.runtimeVersion).toBe('arcade-v3');
    expect(w.logic).toEqual({ bodies: [2, 3] });
    expect(w.initial[HEADER.spawnBase]).toBe(2 + LOGIC_BODIES);
    for (const index of w.logic?.bodies ?? []) {
      const base = bodyBase(index);
      expect(w.initial[base + BODY.role]).toBe(ROLE.logic);
      expect((w.initial[base + BODY.flags] as number) & FLAG.alive).toBe(0);
      expect([w.initial[base + BODY.w], w.initial[base + BODY.h], w.initial[base + BODY.d]]).toEqual([0, 0, 0]);
    }
    const state = instantiate(w);
    expect(vars8(state)).toEqual([7, 0, 0, 0, 0, 0, 0, -3]);
    expect(phaseOf(state, logicBase(state))).toBe(0);
  });
});

describe('timer pass', () => {
  it('a timer started in tick s runs out exactly in tick s + n, once', () => {
    const w = world(
      [
        ['at_tick', 5, [{ kind: 'startTimer', timer: 1, ticks: 7 }]],
        ['on_timer', 1, [add(0)]],
        ['at_tick', 9, [{ kind: 'startTimer', timer: 0, ticks: 1 }]],
        ['on_timer', 0, [add(2)]],
        // Spuštěný z průchodu fází (vstup do počáteční fáze v tiku 0).
        ['on_enter', 0, [{ kind: 'startTimer', timer: 2, ticks: 3 }]],
        ['on_timer', 2, [add(1)]],
      ],
      { vars: [], phases: 2 },
    );
    const { history, state } = run(w, 30);
    expect(changedAt(history, 0)).toEqual([12]);
    expect(changedAt(history, 2)).toEqual([10]);
    expect(changedAt(history, 1)).toEqual([3]);
    expect([0, 1, 2, 3].map((t) => timerLeft(state, logicBase(state), t))).toEqual([0, 0, 0, 0]);
  });

  it('a stopped timer never runs out', () => {
    const w = world(
      [
        ['at_tick', 0, [{ kind: 'startTimer', timer: 3, ticks: 5 }]],
        ['at_tick', 3, [{ kind: 'stopTimer', timer: 3 }]],
        ['on_timer', 3, [add(0)]],
      ],
      { vars: [], phases: 0 },
    );
    expect(changedAt(run(w, 20).history, 0)).toEqual([]);
  });
});

describe('phase pass', () => {
  it('A → B fires the exit of A and the entry of B in the same tick, once; the start phase is entered in tick 0', () => {
    const w = world(
      [
        ['at_tick', 4, [{ kind: 'goPhase', phase: 1 }]],
        ['at_tick', 8, [{ kind: 'goPhase', phase: 1 }]],
        ['on_exit', 0, [add(0)]],
        ['on_enter', 1, [add(1)]],
        ['on_enter', 0, [add(2)]],
        ['on_exit', 1, [add(3)]],
      ],
      { vars: [], phases: 3 },
    );
    const { history, state } = run(w, 20);
    expect(changedAt(history, 0)).toEqual([4]);
    expect(changedAt(history, 1)).toEqual([4]);
    expect(changedAt(history, 2)).toEqual([0]);
    expect(changedAt(history, 3)).toEqual([]);
    expect(phaseOf(state, logicBase(state))).toBe(1);
    expect(state[logicBase(state) + LOGIC_SLOTS.phaseTick]).toBe(4);
  });

  it('a phase change sent from the phase pass waits for the next tick', () => {
    const w = world(
      [
        ['on_enter', 0, [{ kind: 'goPhase', phase: 1 }]],
        ['on_enter', 1, [add(0)]],
      ],
      { vars: [], phases: 2 },
    );
    expect(changedAt(run(w, 10).history, 0)).toEqual([1]);
  });
});

describe('event pass', () => {
  it('an event sent in tick t fires in t from the main pass or in t + 1 from the event pass, never twice', () => {
    const w = world(
      [
        ['at_tick', 3, [{ kind: 'emit', event: 0 }]],
        ['on_event', 0, [add(0), { kind: 'emit', event: 1 }]],
        ['on_event', 1, [add(1)]],
        // Dvě vyslání téže události v jednom tiku = jeden výstřel.
        ['at_tick', 6, [{ kind: 'emit', event: 2 }]],
        ['at_tick', 6, [{ kind: 'emit', event: 2 }]],
        ['on_event', 2, [add(2)]],
      ],
      { vars: [], phases: 0 },
    );
    const { history } = run(w, 20);
    expect(changedAt(history, 0)).toEqual([3]);
    expect(changedAt(history, 1)).toEqual([4]);
    expect(changedAt(history, 2)).toEqual([6]);
    expect(history.at(-1)?.slice(0, 3)).toEqual([1, 1, 1]);
  });

  it('a ring of 8 events never stalls a tick: exactly one event fires per tick', () => {
    const ring: Rule[] = Array.from({ length: 8 }, (_, i) => ['on_event', i, [add(i), { kind: 'emit', event: (i + 1) % 8 }]] as const);
    const w = world([['at_tick', 0, [{ kind: 'emit', event: 0 }]], ...ring], { vars: [], phases: 0 });
    const { history } = run(w, 40);
    history.forEach((vars, t) => {
      expect(vars.reduce((sum, v) => sum + v, 0)).toBe(t + 1);
      expect(changedAt(history, t % 8)).toContain(t);
    });
  });
});

describe('effects report a trace only on a real change', () => {
  it('same value, same phase, same remaining ticks, a pending event and a latch are silent', () => {
    const w = world(
      [
        ['at_tick', 2, [{ kind: 'setVar', var: 0, value: 5 }, { kind: 'setVar', var: 0, value: 6 }]],
        ['at_tick', 3, [{ kind: 'goPhase', phase: 0 }, add(1, 5), add(1, 5)]],
        ['at_tick', 4, [{ kind: 'startTimer', timer: 0, ticks: 10 }, { kind: 'stopTimer', timer: 1 }]],
        ['at_tick', 5, [{ kind: 'startTimer', timer: 0, ticks: 10 }]],
        ['at_tick', 6, [{ kind: 'emit', event: 4 }, { kind: 'emit', event: 4 }, { kind: 'latch', bit: 0, on: true }]],
      ],
      { vars: [5, 99_998], phases: 2 },
    );
    const { traced, state } = run(w, 8);
    expect(traced).toEqual([
      '2 {"kind":"setVar","var":0,"value":6}',
      '3 {"kind":"addVar","var":1,"amount":5}',
      '4 {"kind":"startTimer","timer":0,"ticks":10}',
      '6 {"kind":"emit","event":4}',
    ]);
    expect(varValue(state, logicBase(state), 1)).toBe(100_000);
    expect(state[logicBase(state) + LOGIC_SLOTS.varLatch]).toBe(1);
  });
});

describe('spawn and logic bodies', () => {
  it('spawn never overwrites a logic body', () => {
    const spawn = (z: number): ArcadeEffect => ({ kind: 'spawn', template: 1, x: 50_000, y: 0, z, vx: 0, vy: 0, vz: 0 });
    const w = world(
      [1, 2, 3, 4, 5].map((t) => ['at_tick', t, [spawn(50_000 + t * 1000)]] as const),
      { vars: [7, 0, 0, 0, 0, 0, 0, -3], phases: 2 },
      3,
    );
    const { state } = run(w, 8);
    expect(state[HEADER.bodyCount]).toBe(2 + LOGIC_BODIES + 3);
    for (const index of w.logic?.bodies ?? []) {
      expect(state[bodyBase(index) + BODY.role]).toBe(ROLE.logic);
      expect((state[bodyBase(index) + BODY.flags] as number) & FLAG.alive).toBe(0);
    }
    for (let i = 2 + LOGIC_BODIES; i < 2 + LOGIC_BODIES + 3; i += 1) expect(state[bodyBase(i) + BODY.role]).toBe(ROLE.collectible);
    expect(vars8(state)).toEqual([7, 0, 0, 0, 0, 0, 0, -3]);
  });
});

describe('determinism', () => {
  const rules: Rule[] = [
    ['on_enter', 0, [{ kind: 'startTimer', timer: 0, ticks: 30 }]],
    ['on_timer', 0, [{ kind: 'goPhase', phase: 1 }, { kind: 'emit', event: 0 }]],
    ['on_enter', 1, [{ kind: 'startTimer', timer: 1, ticks: 20 }, add(0, 3)]],
    ['on_event', 0, [add(1, 2)]],
    ['on_timer', 1, [{ kind: 'goPhase', phase: 2 }]],
  ];

  it('the same world gives the same hash on two replays', () => {
    const w = world(rules, { vars: [1, 2], phases: 3 });
    expect(replay(w, [], library, 80)).toEqual(replay(w, [], library, 80));
  });

  it('the same hash on two runs with a different pause between ticks', () => {
    const w = world(rules, { vars: [1, 2], phases: 3 });
    const fast = run(w, 80);
    const slow = run(w, 80, 2);
    expect(hashArcade(slow.state)).toBe(hashArcade(fast.state));
    expect(slow.history).toEqual(fast.history);
    expect(phaseOf(fast.state, logicBase(fast.state))).toBe(2);
  });
});
