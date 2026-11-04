/**
 * Odpuštění ťuku v poletování, načasování a rytmu (P37A T7, `feel: 2`) se
 * stejnými okny jako skok skákačky a běžce (`PLATFORM_FEEL`: pozdě do 6 tiků,
 * brzy do 7). Kdo dnes ťukne o 4 tiky dřív nebo později, ztratí život nebo
 * prohraje; s `feel` projde. Skákačku a běžce drží `platform-feel` a `runner-feel`.
 *
 * Co by vypadalo dobře a bylo špatně: žánr `feel` píše, ale kompilátor ho
 * ovládání nepředá; okno odpustí cokoli (ťuk kdykoli = trefa); nebo uložená
 * hra bez `feel` začne odpouštět a přestane se přehrávat (hash).
 */

import { describe, expect, it } from 'vitest';

import { compileGenre } from '@/play/genre/index';
import type { GenreSpec } from '@/play/genre/contract';
import type { GameSpecV1 } from '@/play/spec';

import flapFixture from '../__fixtures__/flap.json';
import { baseControlOf } from '../addons';
import { arcadeWorldOf } from '../compile';
import { type ArcadeInput, type ArcadeWorld, BODY, BUTTON, HIT_GRACE, NO_INPUT, bodyBase } from '../contract';
import { hashArcade, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { PLATFORM_FEEL } from '../pieces/platform';
import { RHYTHM, beatMap, rhythmLevel } from '../pieces/rhythm';
import { TIMING, TIMING_SLOTS } from '../pieces/timing';
import { runBot } from '../verify';

const TAP: ArcadeInput = { buttons: BUTTON.TAP, axis: 0 };
type Tapped = 'flap' | 'timing' | 'rhythm';

function worldOf(spec: GameSpecV1, seed = 1): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Hra ovládání `control` krok po kroku; spec na šabloně poletování – kompilátor čte jen `control`, parametry a mechaniky. */
function game(control: Tapped, controlParams: Record<string, unknown>) {
  const world = worldOf({ ...(flapFixture as GameSpecV1), control, controlParams });
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  return {
    world,
    state,
    step: (input: ArcadeInput = NO_INPUT) => step(state, input, program),
    outcome: () => outcomeOf(state),
    /** Výsledek ťuku v tomto tiku (`aux0` hráče): body trefy, −1 minutí, 0 nic. */
    result: () => state[bodyBase(0) + BODY.aux0] as number,
  };
}

const withFeel = (params: Record<string, unknown>, feel: 2 | undefined): Record<string, unknown> => (feel === undefined ? params : { ...params, feel });

// ---------------------------------------------------------------- poletování

const FLAP_PARAMS = { difficulty: 'easy', lengthM: 120 };

/** Nečinný pták spadne na zem (první trubka je až za rozletem): hra v tiku prvního doteku. */
function landed(feel: 2 | undefined) {
  const g = game('flap', withFeel(FLAP_PARAMS, feel));
  const y = (): number => g.state[bodyBase(0) + BODY.y] as number;
  for (let i = 0; i < 120 && y() > 0; i += 1) g.step();
  expect(y(), 'the bird is on the ground').toBe(0);
  return { ...g, y };
}

describe('flap feel: 2 – a late flap off the ground', () => {
  it('a flap 4 ticks after touching the ground still takes off; without feel the touch loses', () => {
    const felt = landed(2);
    expect(felt.outcome()).toBe('running');
    for (let i = 0; i < 3; i += 1) felt.step();
    felt.step(TAP);
    expect(felt.y()).toBeGreaterThan(0);
    expect(felt.outcome()).toBe('running');
    expect(landed(undefined).outcome()).toBe('lost');
  });

  it('the ground wins after 100 ms (6 ticks) without a flap', () => {
    const felt = landed(2);
    for (let i = 0; i < PLATFORM_FEEL.coyoteTicks - 1; i += 1) felt.step();
    expect(felt.outcome()).toBe('running');
    felt.step();
    expect(felt.outcome()).toBe('lost');
  });
});

// ---------------------------------------------------------------- načasování

const TIMING_PARAMS = { mode: 'precision', speed: 'normal', rounds: 8 };

/** První a poslední tik prvního kyvu, kdy je jezdec na začátku tiku v okně cíle. */
function windowTicks(): { readonly first: number; readonly last: number; readonly tolerance: number } {
  const g = game('timing', TIMING_PARAMS);
  const slider = bodyBase(TIMING_SLOTS.slider);
  const target = bodyBase(TIMING_SLOTS.target);
  const center = g.state[target + BODY.x] as number;
  const tolerance = Math.floor((g.state[target + BODY.w] as number) / 2);
  const inside: number[] = [];
  for (let tick = 0; tick < g.state[slider + BODY.aux1]!; tick += 1) {
    if (Math.abs((g.state[slider + BODY.x] as number) - center) <= tolerance) inside.push(tick);
    g.step();
  }
  return { first: inside[0] as number, last: inside.at(-1) as number, tolerance };
}

/** Ťuk v tiku `at` prvního kyvu. */
function timingTap(at: number, feel: 2 | undefined, mode = 'precision') {
  const g = game('timing', withFeel({ ...TIMING_PARAMS, mode }, feel));
  for (let tick = 0; tick < at; tick += 1) g.step();
  g.step(TAP);
  return g;
}

describe('timing feel: 2 – early and late taps', () => {
  const { first, last, tolerance } = windowTicks();

  it('the slider passes the window once per swing', () => {
    expect(last - first + 1).toBe(2 * Math.floor(tolerance / TIMING.speed.normal) + 1);
  });

  it('a tap 4 ticks before the window scores 1; without feel it misses', () => {
    expect(timingTap(first - 4, 2).result()).toBe(1);
    expect(timingTap(first - 4, undefined).result()).toBe(-1);
  });

  it('a tap 4 ticks after the window scores 1; without feel it misses', () => {
    expect(timingTap(last + 4, 2).result()).toBe(1);
    expect(timingTap(last + 4, undefined).result()).toBe(-1);
  });

  it('the windows close: 7 ticks early and 6 late still count, 8 early and 7 late miss', () => {
    expect(timingTap(first - PLATFORM_FEEL.bufferTicks, 2).result()).toBe(1);
    expect(timingTap(first - PLATFORM_FEEL.bufferTicks - 1, 2).result()).toBe(-1);
    expect(timingTap(last + PLATFORM_FEEL.coyoteTicks, 2).result()).toBe(1);
    expect(timingTap(last + PLATFORM_FEEL.coyoteTicks + 1, 2).result()).toBe(-1);
  });

  it('an on-time tap scores as before', () => {
    expect(timingTap((first + last) / 2, 2).result()).toBe(3);
  });

  it('a forgiven tap lands on the edge of the window, not where the slider was', () => {
    const precise = timingTap(first - 4, 2);
    expect(Math.abs(precise.state[bodyBase(TIMING_SLOTS.marks) + BODY.x] as number)).toBe(tolerance);
    const stacked = timingTap(first - 4, 2, 'stack');
    expect(stacked.state[bodyBase(TIMING_SLOTS.slider) + BODY.w]).toBe(TIMING.blockW - tolerance);
  });
});

// ---------------------------------------------------------------- rytmus

const RHYTHM_PARAMS = { bpm: 120, density: 'sparse', beats: 24 };
const [NOTE, NEXT] = beatMap(1, rhythmLevel.params.parse(RHYTHM_PARAMS)) as [number, number];
const W = RHYTHM.window;

/** Ťuk v tiku `at`; nota dorazí na lištu v tiku `NOTE`. */
function rhythmTap(at: number, feel: 2 | undefined) {
  const g = game('rhythm', withFeel(RHYTHM_PARAMS, feel));
  for (let tick = 0; tick < at; tick += 1) g.step();
  g.step(TAP);
  return g;
}

/** Tik, ve kterém nečinný hráč minul první notu. */
function idleMiss(feel: 2 | undefined): number {
  const g = game('rhythm', withFeel(RHYTHM_PARAMS, feel));
  for (let tick = 0; tick < NEXT; tick += 1) {
    g.step();
    if (g.result() === -1) return tick;
  }
  throw new Error('the first note was never missed');
}

describe('rhythm feel: 2 – early and late taps', () => {
  it('the next note is far enough not to answer the taps below', () => {
    expect(NEXT - NOTE).toBeGreaterThan(2 * (W + PLATFORM_FEEL.bufferTicks));
  });

  it('a tap 4 ticks before the window hits for 1; without feel it misses', () => {
    expect(rhythmTap(NOTE - W - 4, 2).result()).toBe(1);
    expect(rhythmTap(NOTE - W - 4, undefined).result()).toBe(-1);
  });

  it('a tap 4 ticks after the window hits for 1; without feel the note is already gone', () => {
    expect(rhythmTap(NOTE + W + 4, 2).result()).toBe(1);
    expect(rhythmTap(NOTE + W + 4, undefined).result()).toBe(-1);
  });

  it('the windows close: 7 early and 6 late still hit, 8 early and 7 late miss', () => {
    expect(rhythmTap(NOTE - W - PLATFORM_FEEL.bufferTicks, 2).result()).toBe(1);
    expect(rhythmTap(NOTE - W - PLATFORM_FEEL.bufferTicks - 1, 2).result()).toBe(-1);
    expect(rhythmTap(NOTE + W + PLATFORM_FEEL.coyoteTicks, 2).result()).toBe(1);
    expect(rhythmTap(NOTE + W + PLATFORM_FEEL.coyoteTicks + 1, 2).result()).toBe(-1);
  });

  it('an on-time tap scores as before', () => {
    expect(rhythmTap(NOTE, 2).result()).toBe(3);
  });

  it('a note an idle player lets pass is missed only after the late window', () => {
    expect(idleMiss(undefined)).toBe(NOTE + W + 1);
    expect(idleMiss(2)).toBe(NOTE + W + PLATFORM_FEEL.coyoteTicks + 1);
  });
});

// ---------------------------------------------------------------- žánry a uložené hry

const GENRES: Readonly<Record<string, GenreSpec>> = {
  flap: { genre: 'flap', mode: 'default', hero: 'parrot', setting: 'jungle canyon' },
  'timing.stack': { genre: 'timing', mode: 'stack', hero: 'chef', cast: [{ label: 'pancake', does: 'collect' }], setting: 'diner kitchen' },
  'timing.precision': { genre: 'timing', mode: 'precision', hero: 'robot', setting: 'factory' },
  'timing.bridge': { genre: 'timing', mode: 'bridge', hero: 'goat', setting: 'canyon' },
  rhythm: { genre: 'rhythm', mode: 'default', hero: 'frog', setting: 'pond' },
};

/** Spec žánrové hry bez `feel`; `stored` = jak ji uložila hra před T7 (i před průběhem P45C, `genre.v1`). */
function storedSpec(name: string, stored = true): GameSpecV1 {
  const spec = compileGenre(GENRES[name] as GenreSpec);
  const { feel: _feel, ...params } = (spec.controlParams ?? {}) as Record<string, unknown>;
  const genre = stored && spec.genre !== undefined ? { genre: { ...spec.genre, compilerVersion: 'genre.v1' } } : {};
  return { ...spec, controlParams: params, ...genre } as GameSpecV1;
}

describe('who gets feel: 2', () => {
  it.each(Object.keys(GENRES))('every %s genre game carries feel: 2 to the control', (name) => {
    const spec = compileGenre(GENRES[name] as GenreSpec);
    expect(spec.controlParams).toMatchObject({ feel: 2 });
    const world = worldOf(spec);
    expect(baseControlOf(world.control).params).toMatchObject({ feel: 2 });
    if (name === 'flap') {
      // Férový start (P70A T3, `genre.v8`): zem stojí život s milostí a ptáček se odrazí – kojotí tiky prohry odpadly.
      expect(world.rules).toContainEqual({ id: 'fall_out', params: { belowY: 1, effect: 'damage', grace: HIT_GRACE } });
      // Uložená `genre.v7` s `feel: 2` dál prohraje dotekem země až po kojotích ticích.
      const stored = worldOf({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v7' } });
      expect(baseControlOf(stored.control).params).toMatchObject({ feel: 2 });
      expect(stored.rules).toContainEqual({ id: 'fall_out', params: { belowY: 1, effect: 'lose', afterTicks: PLATFORM_FEEL.coyoteTicks } });
    }
  });

  it.each(Object.keys(GENRES))('%s: the robot wins at the same tick and an idle player still loses', (name) => {
    const felt = worldOf(compileGenre(GENRES[name] as GenreSpec));
    const stored = worldOf(storedSpec(name, false));
    const bot = runBot(felt);
    expect(bot.outcome).toBe('won');
    expect(bot.tick).toBe(runBot(stored).tick);
    expect(replay(felt, [], ARCADE_LIBRARY).outcome).toBe('lost');
  });
});

// [hra, hash počátečního stavu, tik výhry robota, hash výhry, hash nečinného hráče] – semínko 1, změřené na `p37-base` (před T7).
const STORED = [
  ['flap', 'cab12970', 2230, '841a9672', '18a621dc'],
  ['timing.stack', '6917a764', 1892, '7aafb236', 'b86d6866'],
  ['timing.precision', '5c4c33b5', 1892, '463455dd', '3eee9b77'],
  ['timing.bridge', '1ed4575a', 1892, '2881e01a', 'd5160638'],
  ['rhythm', 'f1dd0490', 2131, '7674c6a7', 'd23f0141'],
] as const;

describe('stored flap, timing and rhythm genre games build the world they had before T7', () => {
  it.each(STORED)('%s', (name, initial, tick, won, idle) => {
    const world = worldOf(storedSpec(name));
    expect(world.control.params).not.toHaveProperty('feel');
    const bot = runBot(world);
    expect(hashArcade(instantiate(world))).toBe(initial);
    expect(bot.tick).toBe(tick);
    expect(bot.hash).toBe(won);
    expect(replay(world, [], ARCADE_LIBRARY).hash).toBe(idle);
  });
});
