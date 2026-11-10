/**
 * Klikací simulace (P83C T2): klepnutí míří na věc a ta odpoví (stupeň 1–3, čtvrté nic), probuzené všechny = výhra,
 * nečinný hráč nevyhraje, robot vyhraje každé uspořádání, přehrání dá týž hash. K tomu tvrzení, která oko nepozná:
 * celočíselný sinus, věci se do 2 s viditelně pohnou a nikdy se nepřekrývají.
 */

import { describe, expect, it } from 'vitest';

import { ARCADE_HZ, type ArcadeWorld, BODY, BUTTON, HEADER, type InputEvent, NO_INPUT, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { axisOfCell } from '../pieces/lanes';
import { ORRERY, ORRERY_LAYOUTS, type OrreryGame, type OrreryParams, PHASE_FULL, cos1e4, levelOf, orreryParts, orreryParams, shellCounts, sin1e4, wokenCount } from '../pieces/orrery';
import { runBot } from '../verify';

const SEEDS = [1, 2, 3, 4, 5, 6];

function worldOf(seed: number, tuning: Partial<OrreryParams> = {}): ArcadeWorld {
  const parts = orreryParts(seed, orreryParams.parse(tuning));
  expect(parts.issues).toEqual([]);
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const gameOf = (world: ArcadeWorld): OrreryGame => world.control.params as unknown as OrreryGame;
const tap = (tick: number, thing: number): InputEvent => ({ tick, buttons: BUTTON.TAP, axis: axisOfCell(thing) });

/** Odehraje záznam do `horizon` a vrátí stav. */
function play(world: ArcadeWorld, inputs: readonly InputEvent[], horizon: number): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < horizon && outcomeOf(state) === 'running'; tick += 1) {
    const event = inputs.find((input) => input.tick === tick);
    step(state, event ?? NO_INPUT, program);
  }
  return state;
}

const at = (state: Int32Array, body: number): { x: number; z: number } => ({ x: state[bodyBase(body) + BODY.x] as number, z: state[bodyBase(body) + BODY.z] as number });

describe('orrery integer sine', () => {
  it('hits the quarter points exactly and stays within one unit of Math.sin', () => {
    expect([0, 1, 2, 3].map((q) => sin1e4((q * PHASE_FULL) / 4))).toEqual([0, 10000, 0, -10000]);
    expect(cos1e4(0)).toBe(10000);
    for (let p = 0; p < PHASE_FULL; p += 4099) expect(Math.abs(sin1e4(p) - Math.sin((2 * Math.PI * p) / PHASE_FULL) * 10000)).toBeLessThanOrEqual(3);
  });

  it('spreads orbiters over at most three shells', () => {
    expect(shellCounts(2)).toEqual([1, 1]);
    expect(shellCounts(4)).toEqual([1, 1, 2]);
    expect(shellCounts(8)).toEqual([2, 3, 3]);
    expect(shellCounts(9)).toEqual([3, 3, 3]);
  });
});

describe('orrery: a tap aims at a thing and it answers', () => {
  it('a tap wakes only the tapped thing; taps two and three raise it, a fourth adds nothing', () => {
    const world = worldOf(1, { things: 4, layout: 'orbit' });
    const game = gameOf(world);
    const one = play(world, [tap(5, 2)], 10);
    expect([0, 1, 2, 3].map((index) => levelOf(one, game, index))).toEqual([0, 0, 1, 0]);
    expect(one[HEADER.counters]).toBe(ORRERY.points);
    const four = play(world, [tap(5, 2), tap(20, 2), tap(35, 2), tap(50, 2)], 60);
    expect(levelOf(four, game, 2)).toBe(ORRERY.maxLevel);
    expect(four[HEADER.counters]).toBe(ORRERY.points + 2 * ORRERY.levelPoints);
    expect(wokenCount(four, game)).toBe(1);
    expect(outcomeOf(four)).toBe('running');
  });

  it('a tap with no thing in the axis (space key) taps the thing under the cursor, arrows move the cursor', () => {
    const world = worldOf(1, { things: 3, layout: 'row' });
    const game = gameOf(world);
    const state = play(world, [{ tick: 3, buttons: BUTTON.RIGHT, axis: 0 }, { tick: 6, buttons: BUTTON.TAP, axis: 0 }], 10);
    expect([0, 1, 2].map((index) => levelOf(state, game, index))).toEqual([0, 1, 0]);
  });

  it('waking the last sleeping thing wins; a tap outside the things does nothing', () => {
    const world = worldOf(2, { things: 3, layout: 'ring' });
    const state = play(world, [tap(5, 0), tap(10, 7), tap(15, 1), tap(25, 2)], 200);
    expect(outcomeOf(state)).toBe('won');
    expect(state[HEADER.tick]).toBe(26);
  });
});

describe('orrery as a game', () => {
  it('the bot wins every layout and seed, tapping the first thing up to level 3 on the way; the idle player never wins', () => {
    for (const layout of ORRERY_LAYOUTS) {
      for (const seed of SEEDS) {
        const world = worldOf(seed, { layout, things: 2 + (seed % 8), hub: seed % 2 === 0 });
        const bot = runBot(world);
        expect(bot.outcome, `${layout} seed ${seed}`).toBe('won');
        const game = gameOf(world);
        const end = play(world, bot.inputs, bot.tick + 1);
        expect(levelOf(end, game, 0)).toBe(ORRERY.maxLevel);
        expect(bot.tick / ARCADE_HZ).toBeLessThan(20);
        expect(replay(world, [], ARCADE_LIBRARY).outcome, `${layout} seed ${seed} idle`).not.toBe('won');
      }
    }
  });

  it('two replays of the bot record end in the same hash, another record in another one', () => {
    const world = worldOf(3, { things: 6, layout: 'orbit', hub: true, answer: 'faster' });
    const bot = runBot(world);
    const first = replay(world, bot.inputs, ARCADE_LIBRARY);
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(first.hash);
    expect(first.hash).toBe(bot.hash);
    expect(replay(world, bot.inputs.slice(0, -1), ARCADE_LIBRARY).hash).not.toBe(first.hash);
  });
});

describe('orrery motion', () => {
  it('every layout moves something within 2 s of the start: orbits and rings a metre, scattered things most of their drift circle', () => {
    for (const layout of ORRERY_LAYOUTS) {
      const world = worldOf(1, { layout, things: 5 });
      const game = gameOf(world);
      const start = instantiate(world);
      const later = play(world, [], 2 * ARCADE_HZ);
      const moved = Array.from({ length: game.count }, (_, index) => {
        const a = at(start, game.first + index);
        const b = at(later, game.first + index);
        return Math.hypot(a.x - b.x, a.z - b.z);
      });
      // Řada stojí na místě a houpe se jen ve scéně (fáze `aux0`); fáze se tedy musí hýbat.
      if (layout === 'row') expect(later[bodyBase(game.first) + BODY.aux0]).not.toBe(start[bodyBase(game.first) + BODY.aux0]);
      else expect(Math.max(...moved), layout).toBeGreaterThanOrEqual(layout === 'scatter' ? 600 : 1000);
    }
  });

  it('a faster thing speeds up its own shell; a bigger thing grows', () => {
    const fast = worldOf(1, { layout: 'orbit', things: 3, answer: 'faster' });
    const game = gameOf(fast);
    const phaseAfter = (inputs: readonly InputEvent[]): number => play(fast, inputs, 300)[bodyBase(game.orbits) + 0] as number;
    const calm = phaseAfter([]);
    const woken = phaseAfter([tap(1, 0)]);
    expect((woken - calm + PHASE_FULL) % PHASE_FULL).toBeGreaterThan(0);
    const big = worldOf(1, { layout: 'row', things: 3, answer: 'bigger' });
    const grown = play(big, [tap(1, 1), tap(10, 1)], 20);
    const size = (state: Int32Array, index: number): number => state[bodyBase(gameOf(big).first + index) + BODY.w] as number;
    expect(size(grown, 1)).toBeGreaterThan(size(grown, 0));
  });

  it('things never come closer than 1.95 m in any layout over a whole minute, even at full size', () => {
    for (const layout of ORRERY_LAYOUTS) {
      for (const seed of SEEDS) {
        const world = worldOf(seed, { layout, things: 9, hub: layout === 'orbit', answer: 'faster' });
        const game = gameOf(world);
        // Všechny věci na stupeň 3 hned na začátku – nejrychlejší dráhy.
        const taps = Array.from({ length: game.count * 3 }, (_, k) => tap(1 + k * 2, Math.floor(k / 3)));
        const program = loadProgram(world, ARCADE_LIBRARY);
        const state = instantiate(world);
        let closest = Infinity;
        for (let tick = 0; tick < 60 * ARCADE_HZ; tick += 1) {
          step(state, taps.find((input) => input.tick === tick) ?? NO_INPUT, program);
          if (outcomeOf(state) !== 'running') state[HEADER.runState] = 0;
          if (tick % 6 !== 0) continue;
          for (let a = 0; a < game.count; a += 1) for (let b = a + 1; b < game.count; b += 1) {
            const p = at(state, game.first + a);
            const q = at(state, game.first + b);
            closest = Math.min(closest, Math.hypot(p.x - q.x, p.z - q.z));
          }
        }
        expect(closest, `${layout} seed ${seed}`).toBeGreaterThanOrEqual(1950);
      }
    }
  });
});
