/**
 * Robot plánuje přes logiku (P45B T6): osm ručních světů ze specu, kde cesta k výhře vede přes
 * proměnnou, časovač, fázi, událost nebo vlnu. Robot, který vyhraje náhodou (časovač doběhne
 * dřív, než cokoli udělá), vypadá jako plánovač – proto test čte stopu výstřelů pravidel a
 * jmenuje pořadí: kolikrát které pravidlo vystřelilo a v jakém tiku vůči ostatním. Každý svět
 * robot vyhraje do horizontu jádra (5400 tiků) a nečinný hráč ne.
 */

import { describe, expect, it } from 'vitest';

import { type GameSpecV1, readGameSpec } from '@/play/spec';

import collectGate from '../__fixtures__/rules/collect-gate.json';
import { underlyingRule } from '../addons';
import { arcadeWorldOf } from '../compile';
import { ARCADE_LIMITS, type ArcadeWorld, NO_INPUT, logicBase, varValue } from '../contract';
import { instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { runBot } from '../verify';

/** Tři rozmístění dvorku na svět: robot nesmí umět jen jedno. */
const SEEDS = [1, 2, 3];

const { rules: _rules, roles: _roles, ...BASE } = collectGate;

interface Shape {
  readonly logic: unknown;
  readonly roles: readonly unknown[];
  readonly rules: readonly unknown[];
  readonly things?: readonly unknown[];
}

function made(shape: Shape, seed: number): ArcadeWorld {
  const spec = readGameSpec({ ...BASE, ...shape, roles: [{ id: 'player', kind: 'player', label: 'scout' }, ...shape.roles] });
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const result = arcadeWorldOf(spec.value as GameSpecV1, seed);
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result.world;
}

interface Played {
  readonly outcome: string;
  readonly tick: number;
  /** Id pravidla ze specu → tiky, ve kterých vystřelilo (pravidlo nejvýš jednou za tik). */
  readonly fired: ReadonlyMap<string, readonly number[]>;
  readonly world: ArcadeWorld;
  readonly state: Int32Array;
}

/** Robotův běh a jeho přehrání se stopou: kdy které pravidlo změnilo stav. */
function botPlays(world: ArcadeWorld): Played {
  const run = runBot(world);
  const ids = world.rules.map((ref) => String(underlyingRule(ref).params.id));
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const fired = new Map<string, number[]>();
  let next = 0;
  for (let tick = 0; tick < run.tick; tick += 1) {
    const event = run.inputs[next];
    const now = event !== undefined && event.tick === tick;
    if (now) next += 1;
    step(state, now ? event : NO_INPUT, program, (rule) => {
      const ticks = fired.get(ids[rule] as string) ?? [];
      if (ticks.at(-1) !== tick) ticks.push(tick);
      fired.set(ids[rule] as string, ticks);
    });
  }
  // Přehrání se stopou musí skončit jako robotův běh, jinak by stopa lhala.
  expect(outcomeOf(state)).toBe(run.outcome);
  return { outcome: run.outcome, tick: run.tick, fired, world, state };
}

/** Nečinný hráč: celý horizont bez vstupu. */
function idleOutcome(world: ArcadeWorld): string {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) step(state, NO_INPUT, program);
  return outcomeOf(state);
}

const ticksOf = (played: Played, id: string): readonly number[] => played.fired.get(id) ?? [];
const once = (played: Played, id: string): number => {
  const ticks = ticksOf(played, id);
  expect(ticks, id).toHaveLength(1);
  return ticks[0] as number;
};

const touch = (id: string, verb: string, role: string, effects: readonly unknown[], conditions?: readonly unknown[]) => ({
  id,
  verb,
  when: { contact: ['player', role] },
  ...(conditions === undefined ? {} : { if: conditions }),
  do: effects,
});

// ---------------------------------------------------------------------------
// Světy

const EXIT = { id: 'exit', kind: 'exit', label: 'stone stairs' };
const GATE = { id: 'gate', kind: 'door', label: 'oak gate' };
const LEAVE = touch('leave', 'escape', 'exit', [{ win: true }]);

/** Sbírej n → otevře se brána: proměnná `gems` (index 1, před ní návnada) překročí 3 a přepne bránu. */
const COLLECT: Shape = {
  logic: { vars: [{ id: 'spare' }, { id: 'gems' }] },
  roles: [{ id: 'gem', kind: 'collectible', label: 'blue gem', count: 3 }, GATE, EXIT],
  rules: [
    touch('pick', 'collect', 'gem', [{ add: { var: 'gems', amount: 1 } }, { despawn: 'other' }]),
    { id: 'open', verb: 'open', when: { var: { name: 'gems', atLeast: 3 } }, do: [{ toggle: 'gate' }] },
    LEAVE,
  ],
};

/**
 * Přežij časovač: bouře (časovač 600 tiků) se spustí v tiku 0 překročením meze `sheltered < 1` a
 * rozestaví kolem hráče vlnu lávy. Když doběhne, vyhraje jen ten, kdo se schoval v chatě – jinak prohra.
 */
const SURVIVE: Shape = {
  logic: { vars: [{ id: 'sheltered' }], timers: [{ id: 'storm' }] },
  roles: [
    { id: 'hut', kind: 'zone', label: 'stone hut' },
    { id: 'lava', kind: 'hazard', label: 'lava pool' },
  ],
  rules: [
    { id: 'brew', verb: 'brew', when: { var: { name: 'sheltered', below: 1 } }, do: [{ startTimer: { timer: 'storm', ticks: 600 } }, { wave: { role: 'lava', count: 4, at: 'player' } }] },
    touch('hide', 'hide', 'hut', [{ set: { var: 'sheltered', value: 1 } }]),
    touch('scorch', 'burn', 'lava', [{ lose: true }]),
    { id: 'outlast', verb: 'survive', when: { timer: 'storm' }, if: [{ var: { name: 'sheltered', atLeast: 1 } }], do: [{ win: true }] },
    { id: 'drown', verb: 'drown', when: { timer: 'storm' }, if: [{ var: { name: 'sheltered', below: 1 } }], do: [{ lose: true }] },
  ],
};

/** Fáze klid → vlna → finále: zvon spustí vlnu duchů, tři zahnaní duchové fázi finále, ve finále se odchází. */
const PHASES: Shape = {
  logic: { vars: [{ id: 'banished' }], phases: [{ id: 'calm' }, { id: 'wave' }, { id: 'final' }] },
  roles: [
    { id: 'bell', kind: 'switch', label: 'brass bell' },
    { id: 'ghost', kind: 'patrol', label: 'pale ghost' },
    EXIT,
  ],
  rules: [
    touch('wake', 'ring', 'bell', [{ goPhase: 'wave' }], [{ inPhase: 'calm' }]),
    { id: 'swarm', verb: 'swarm', when: { phase: 'wave' }, do: [{ wave: { role: 'ghost', count: 3, at: 'edge' } }] },
    touch('banish', 'banish', 'ghost', [{ add: { var: 'banished', amount: 1 } }, { despawn: 'other' }]),
    { id: 'settle', verb: 'settle', when: { var: { name: 'banished', atLeast: 3 } }, do: [{ goPhase: 'final' }] },
    touch('leave', 'escape', 'exit', [{ win: true }], [{ inPhase: 'final' }]),
  ],
  // Duchové jen z vlny: role vlny by jinak dostala i tělo na startu.
  things: [{ role: 'ghost', start: 'hidden' }],
};

/** Událost spustí druhou část: páka vyšle `quake`, ta `crack` (o tik později) a ta otevře bránu k východu. */
const EVENT: Shape = {
  logic: { events: ['crack', 'quake'] },
  roles: [{ id: 'lever', kind: 'switch', label: 'rusty lever' }, GATE, EXIT],
  rules: [
    touch('pull', 'pull', 'lever', [{ emit: 'quake' }]),
    { id: 'rumble', verb: 'rumble', when: { event: 'quake' }, do: [{ emit: 'crack' }] },
    { id: 'split', verb: 'split', when: { event: 'crack' }, do: [{ toggle: 'gate' }] },
    LEAVE,
  ],
};

/** Vlna nepřátel, kterou je třeba porazit: buben přivolá čtyři skřety, každý se srazí úderem zblízka. */
const ENEMIES: Shape = {
  logic: { vars: [{ id: 'slain' }] },
  roles: [
    { id: 'drum', kind: 'switch', label: 'war drum' },
    { id: 'imp', kind: 'chaser', label: 'red imp' },
  ],
  rules: [
    touch('alarm', 'beat', 'drum', [{ wave: { role: 'imp', count: 4, at: 'player' } }, { despawn: 'other' }]),
    { id: 'strike', verb: 'strike', when: { press: 'action' }, if: [{ near: { role: 'imp', within: 1 } }], do: [{ despawn: 'other' }, { add: { var: 'slain', amount: 1 } }] },
    { id: 'victory', verb: 'win', when: { var: { name: 'slain', atLeast: 4 } }, do: [{ win: true }] },
  ],
  things: [{ role: 'imp', start: 'hidden' }],
};

/** Časovač, který musí robot sám spustit: rozbuška zažehne doutnák (90 tiků), výbuch odklidí sutiny z brány. */
const FUSE: Shape = {
  logic: { timers: [{ id: 'spare' }, { id: 'fuse' }] },
  roles: [{ id: 'plunger', kind: 'switch', label: 'blast plunger' }, { id: 'rubble', kind: 'door', label: 'rubble pile' }, EXIT],
  rules: [
    touch('light', 'light', 'plunger', [{ startTimer: { timer: 'fuse', ticks: 90 } }]),
    { id: 'blast', verb: 'blast', when: { timer: 'fuse' }, do: [{ toggle: 'rubble' }] },
    // Návnada: časovač `spare` (index 0) spustí jen stisk, který robot nepotřebuje.
    { id: 'tick', verb: 'tick', when: { press: 'alt' }, do: [{ startTimer: { timer: 'spare', ticks: 30 } }] },
    LEAVE,
  ],
};

/** Proměnná klesající ztrátou: dotek lávy ubere život (`lives` 2 → 1), pod 1 je konec; vyhrává dva krystaly a východ. */
const LIVES: Shape = {
  logic: { vars: [{ id: 'lives', start: 2 }, { id: 'crystals' }] },
  roles: [
    { id: 'crystal', kind: 'collectible', label: 'green crystal', count: 2 },
    { id: 'lava', kind: 'hazard', label: 'lava pool', count: 6 },
    EXIT,
  ],
  rules: [
    touch('pick', 'collect', 'crystal', [{ add: { var: 'crystals', amount: 1 } }, { despawn: 'other' }]),
    touch('burn', 'burn', 'lava', [{ add: { var: 'lives', amount: -1 } }]),
    { id: 'die', verb: 'die', when: { var: { name: 'lives', below: 1 } }, do: [{ lose: true }] },
    touch('leave', 'escape', 'exit', [{ win: true }], [{ var: { name: 'crystals', atLeast: 2 } }]),
  ],
};

/** Fáze s výstupem: pochodeň ukončí noc (`night` → `day`) a odchod z noci otevře bránu. */
const EXIT_PHASE: Shape = {
  logic: { phases: [{ id: 'night' }, { id: 'day' }] },
  roles: [{ id: 'torch', kind: 'switch', label: 'iron torch' }, GATE, EXIT],
  rules: [
    touch('kindle', 'kindle', 'torch', [{ goPhase: 'day' }]),
    { id: 'dawn', verb: 'dawn', when: { phaseExit: 'night' }, do: [{ toggle: 'gate' }] },
    LEAVE,
  ],
};

// ---------------------------------------------------------------------------
// Testy

describe('the rules robot plans through logic', () => {
  /** Robot vyhraje každé semínko do horizontu, nečinný hráč ne; `order` jmenuje pořadí výstřelů. */
  function plays(shape: Shape, order: (played: Played) => void): void {
    for (const seed of SEEDS) {
      const world = made(shape, seed);
      const played = botPlays(world);
      expect({ seed, outcome: played.outcome }).toEqual({ seed, outcome: 'won' });
      expect(played.tick).toBeLessThanOrEqual(ARCADE_LIMITS.maxTicks);
      order(played);
      expect({ seed, idle: idleOutcome(world) }).not.toEqual({ seed, idle: 'won' });
    }
  }

  it('collect n → the gate opens: three picks, the var crossing fires on the third, then the exit', () => {
    plays(COLLECT, (played) => {
      const picks = ticksOf(played, 'pick');
      expect(picks).toHaveLength(3);
      // Proměnná překročí mez v průchodu čítačů téhož tiku jako třetí sběr.
      expect(once(played, 'open')).toBe(picks[2]);
      expect(once(played, 'leave')).toBeGreaterThan(picks[2] as number);
      expect(varValue(played.state, logicBase(played.state), 1)).toBe(3);
    });
  });

  it('survive the timer: the storm starts in tick 0, the robot hides first, wins exactly when the storm runs out, never touches lava', () => {
    plays(SURVIVE, (played) => {
      expect(once(played, 'brew')).toBe(0);
      const hides = ticksOf(played, 'hide');
      expect(hides).toHaveLength(1);
      expect(hides[0]).toBeLessThan(600);
      expect(once(played, 'outlast')).toBe(600);
      expect(ticksOf(played, 'drown')).toEqual([]);
      expect(ticksOf(played, 'scorch')).toEqual([]);
    });
  });

  it('phases calm → wave → final: the bell raises the wave, three ghosts from it end the wave phase, the exit counts only in final', () => {
    plays(PHASES, (played) => {
      const wake = once(played, 'wake');
      // Vstup do fáze vystřelí v průchodu fází téhož tiku.
      expect(once(played, 'swarm')).toBe(wake);
      const banished = ticksOf(played, 'banish');
      expect(banished).toHaveLength(3);
      expect(banished[0]).toBeGreaterThan(wake);
      expect(once(played, 'settle')).toBe(banished[2]);
      expect(once(played, 'leave')).toBeGreaterThan(banished[2] as number);
    });
  });

  it('an event starts the second part: lever → quake (same tick) → crack (next tick) → gate, then the exit behind it', () => {
    plays(EVENT, (played) => {
      const pull = ticksOf(played, 'pull')[0] as number;
      expect(pull).toBeGreaterThan(0);
      expect(ticksOf(played, 'rumble')[0]).toBe(pull);
      // Událost vyslaná z průchodu událostí čeká na další tik.
      expect(ticksOf(played, 'split')[0]).toBe(pull + 1);
      expect(once(played, 'leave')).toBeGreaterThan(pull + 1);
    });
  });

  it('a wave of enemies to beat: the drum calls four imps, the robot strikes each, the fourth strike wins', () => {
    plays(ENEMIES, (played) => {
      const alarm = once(played, 'alarm');
      const strikes = ticksOf(played, 'strike');
      expect(strikes).toHaveLength(4);
      expect(strikes[0]).toBeGreaterThan(alarm);
      expect(once(played, 'victory')).toBe(strikes[3]);
    });
  });

  it('a timer the robot starts itself: it lights the fuse, steps off, the blast comes 90 ticks after the last light and opens the way', () => {
    plays(FUSE, (played) => {
      const lights = ticksOf(played, 'light');
      expect(lights.length).toBeGreaterThan(0);
      // Doutnák doběhne přesně 90 tiků po posledním natažení – robot z rozbušky odstoupil a nečekal na ní.
      const blast = ticksOf(played, 'blast')[0] as number;
      expect(blast).toBe((lights.filter((tick) => tick < blast).at(-1) as number) + 90);
      expect(once(played, 'leave')).toBeGreaterThan(blast);
      expect(ticksOf(played, 'tick')).toEqual([]);
    });
  });

  it('a var falling by loss: the robot treats the life-taking lava as a loss, keeps both lives, picks two crystals, then leaves', () => {
    plays(LIVES, (played) => {
      expect(ticksOf(played, 'burn')).toEqual([]);
      expect(ticksOf(played, 'die')).toEqual([]);
      const picks = ticksOf(played, 'pick');
      expect(picks).toHaveLength(2);
      expect(once(played, 'leave')).toBeGreaterThan(picks[1] as number);
      expect(varValue(played.state, logicBase(played.state), 0)).toBe(2);
    });
  });

  it('a phase with an exit: the torch leaves night, the exit trigger opens the gate the same tick, then the exit', () => {
    plays(EXIT_PHASE, (played) => {
      const kindle = once(played, 'kindle');
      expect(once(played, 'dawn')).toBe(kindle);
      expect(once(played, 'leave')).toBeGreaterThan(kindle);
    });
  });
});
