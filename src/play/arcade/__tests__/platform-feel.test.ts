/**
 * Pocit skoku plošinovky (P32F T2, `feel: 2`): coyote time, buffer skoku a
 * výška podle délky stisku. Skok 29. 9. neodpustil ani tik – kdo zmáčkl pozdě
 * za hranou nebo chvilku před dopadem, spadl. Tyhle testy drží, že nová úroveň
 * odpouští, že ťuk skočí přesně jako dřív (z něj úroveň počítá dosah) a že
 * staré úrovně bez `feel` mají dál tentýž svět i hash.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';
import { compileGenre } from '@/play/genre/index';
import { readGameSpec } from '@/play/spec';

import platformFixture from '../__fixtures__/platform.json';
import { baseControlOf } from '../addons';
import { arcadeWorldOf } from '../compile';
import { type ArcadeInput, type ArcadeLevel, type ArcadeWorld, BODY, BUTTON, FLAG, NO_INPUT, bodyBase } from '../contract';
import { GRAVITY, buildWorld, instantiate, loadProgram, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { PLATFORM, PLATFORM_DIFFICULTIES, PLATFORM_JUMP_PEAK, type PlatformLevelParams, jumpReach, platformControlRef, platformLevel, platformRules } from '../pieces/platform';
import { runBot } from '../verify';

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const params = (extra: Partial<PlatformLevelParams> = {}): PlatformLevelParams => platformLevel.params.parse({ difficulty: 'normal', ...extra });

function worldOf(level: ArcadeLevel, p: PlatformLevelParams): ArcadeWorld {
  const built = buildWorld({ seed: 1, control: platformControlRef(p), rules: platformRules(p), bot: { id: 'platform_bot', params: {} }, level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Hra krok po kroku: stejná úroveň s pocitem `feel` nebo bez něj, nebo hotový svět. */
function play(feel: 2 | undefined | ArcadeWorld) {
  const world = typeof feel === 'object' ? feel : worldOf(platformLevel.generate(1, params()), params(feel === undefined ? {} : { feel }));
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const base = bodyBase(0);
  return {
    step: (input: ArcadeInput = NO_INPUT) => step(state, input, program),
    grounded: () => ((state[base + BODY.flags] as number) & FLAG.grounded) !== 0,
    y: () => state[base + BODY.y] as number,
    vy: () => state[base + BODY.vy] as number,
  };
}

const RUN: ArcadeInput = { buttons: 0, axis: 1000 };
const JUMP: ArcadeInput = { buttons: BUTTON.TAP, axis: 1000 };

/** Doběhne za hranu startovní plošiny: vrátí hru v prvním tiku, kdy hráč nestojí (a neskočil). */
function offTheEdge(feel: 2 | undefined | ArcadeWorld) {
  const game = play(feel);
  for (let i = 0; i < 600 && game.grounded(); i += 1) game.step(RUN);
  expect(game.grounded()).toBe(false);
  expect(game.vy()).toBeLessThanOrEqual(0);
  return game;
}

describe('feel: 2 – coyote time', () => {
  it('a jump pressed 5 ticks (~83 ms, under 90 ms) after running off the edge still jumps', () => {
    const game = offTheEdge(2);
    for (let i = 0; i < 4; i += 1) game.step(RUN);
    game.step(JUMP);
    expect(game.vy()).toBe(PLATFORM.jumpVy - GRAVITY);
  });

  it('the window closes after 100 ms, and without feel it never opened', () => {
    const late = offTheEdge(2);
    for (let i = 0; i < 6; i += 1) late.step(RUN);
    late.step(JUMP);
    expect(late.vy()).toBeLessThan(0);
    const old = offTheEdge(undefined);
    old.step(JUMP);
    expect(old.vy()).toBeLessThan(0);
  });
});

/** Skok z místa: tik, po kterém hráč znovu stojí. */
function landingTick(): number {
  const game = play(undefined);
  game.step({ buttons: BUTTON.TAP, axis: 0 });
  for (let tick = 1; tick < 200; tick += 1) {
    game.step();
    if (game.grounded()) return tick;
  }
  throw new Error('never landed');
}

describe('feel: 2 reaches the platformer genre (P36A T6)', () => {
  // Žánr psal `feel: 2` do `tuning` od P32F, kompilátor ho ale ovládání nepředal – skákačka neodpouštěla.
  const genreWorld = (): ArcadeWorld => {
    const made = arcadeWorldOf(compileGenre({ genre: 'platformer', mode: 'default', hero: 'frog', setting: 'pond' }), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    return made.world;
  };

  it('the genre world carries feel: 2 in its control', () => {
    // Pod obaly průběhu (P46B T6: `pacing_control`, `phase_control`).
    expect(baseControlOf(genreWorld().control).params).toMatchObject({ feel: 2 });
  });

  it('a jump pressed 4 ticks after running off an edge jumps', () => {
    const game = offTheEdge(genreWorld());
    for (let i = 0; i < 3; i += 1) game.step(RUN);
    game.step(JUMP);
    expect(game.vy()).toBe(PLATFORM.jumpVy - GRAVITY);
  });

  it('a jump pressed 5 ticks before landing jumps right after landing', () => {
    const land = landingTick();
    const game = play(genreWorld());
    game.step({ buttons: BUTTON.TAP, axis: 0 });
    for (let tick = 1; tick <= land; tick += 1) game.step(tick === land - 5 ? { buttons: BUTTON.TAP, axis: 0 } : NO_INPUT);
    expect(game.grounded()).toBe(true);
    game.step();
    expect(game.vy()).toBe(PLATFORM.jumpVy - GRAVITY);
  });
});

describe('feel: 2 – jump buffer', () => {
  it('a press 6 ticks (100 ms) before touching down jumps again on landing; without feel it is lost', () => {
    const land = landingTick();
    for (const feel of [2, undefined] as const) {
      const game = play(feel);
      game.step({ buttons: BUTTON.TAP, axis: 0 });
      for (let tick = 1; tick <= land; tick += 1) game.step(tick === land - 6 ? { buttons: BUTTON.TAP, axis: 0 } : NO_INPUT);
      expect(game.grounded()).toBe(true);
      game.step();
      if (feel === 2) expect(game.vy(), 'buffered jump').toBe(PLATFORM.jumpVy - GRAVITY);
      else expect(game.grounded(), 'old feel stays on the ground').toBe(true);
    }
  });

  it('a press 9 ticks before touching down is too early and does nothing', () => {
    const land = landingTick();
    const game = play(2);
    game.step({ buttons: BUTTON.TAP, axis: 0 });
    for (let tick = 1; tick <= land; tick += 1) game.step(tick === land - 9 ? { buttons: BUTTON.TAP, axis: 0 } : NO_INPUT);
    game.step();
    expect(game.grounded()).toBe(true);
  });
});

describe('feel: 2 – jump height follows the press', () => {
  function peak(feel: 2 | undefined, holdTicks: number): number {
    const game = play(feel);
    game.step({ buttons: BUTTON.TAP, axis: 0 });
    let top = game.y();
    for (let tick = 1; tick < 120; tick += 1) {
      game.step(tick <= holdTicks ? { buttons: BUTTON.HOLD, axis: 0 } : NO_INPUT);
      top = Math.max(top, game.y());
    }
    return top - PLATFORM.baseTop;
  }

  it('a short tap jumps lower than a long press, and the tap is exactly the old jump the level is built on', () => {
    const tap = peak(2, 0);
    const long = peak(2, 30);
    expect(tap).toBeLessThan(long);
    expect(peak(2, 4)).toBeLessThan(long);
    expect(tap).toBe(PLATFORM_JUMP_PEAK);
    expect(peak(undefined, 30)).toBe(PLATFORM_JUMP_PEAK);
  });
});

describe('feel: 2 levels', () => {
  it('every jump leaves at least 20 % of the tap jump reach in reserve', () => {
    for (const difficulty of PLATFORM_DIFFICULTIES) {
      for (const seed of SEEDS.slice(0, 60)) {
        const level = platformLevel.generate(seed, params({ difficulty, feel: 2, movingPlatforms: seed % 3 === 0 }));
        const spans = level.bodies
          .filter((body) => body.role === 'platform')
          .map((body) => {
            const shift = body.kinematic === true ? (body.vz ?? 0) * (body.period ?? 0) : 0;
            return { near: body.z + Math.min(0, shift) - body.d / 2, far: body.z + Math.max(0, shift) + body.d / 2, top: body.y + body.h };
          })
          .sort((a, b) => a.near - b.near);
        spans.slice(1).forEach((next, i) => {
          const from = spans[i]!;
          const gap = next.near - from.far;
          expect(gap, `${difficulty}/${seed} gap at ${from.far}`).toBeLessThanOrEqual(0.8 * jumpReach(next.top - from.top));
        });
      }
    }
  });

  it('the bot wins at least 95 % of 200 seeds, easy to hard, some with moving platforms', () => {
    const lost: string[] = [];
    for (const seed of SEEDS) {
      const p = params({ difficulty: PLATFORM_DIFFICULTIES[seed % 3], feel: 2, movingPlatforms: seed % 4 === 0, checkpoints: seed % 5 === 0 });
      const run = runBot(worldOf(platformLevel.generate(seed, p), p));
      if (run.outcome !== 'won') lost.push(`${seed}:${run.outcome}@${run.tick}`);
    }
    expect(lost.length, lost.join(' ')).toBeLessThanOrEqual(SEEDS.length / 20);
  }, 240_000);

  it('the feel travels in the control params, so a feel: 2 world is a different world', () => {
    const level = platformLevel.generate(1, params());
    expect(platformControlRef(params({ feel: 2 })).params).toEqual({ doubleJump: false, feel: 2 });
    expect(canonicalHash(worldOf(level, params({ feel: 2 })))).not.toBe(canonicalHash(worldOf(level, params())));
  });
});

/**
 * Svět a robotův hash dnešních plošinovek (29. 9. 2026, před P32F T2):
 * fixtura `platform.json` a varianty. Pocit skoku je nesmí pohnout.
 */
const PLATFORM_PINS: readonly (readonly [string, Record<string, unknown>, number, string, string])[] = [
  ['platform.json', platformFixture.controlParams, 1, '999c11f0', 'c27cf076'],
  ['platform.json', platformFixture.controlParams, 2, '93cf2062', '8d52bb2e'],
  ['platform.json', platformFixture.controlParams, 3, '3f268a69', 'c72c356f'],
  ['hard, moving', { difficulty: 'hard', movingPlatforms: true }, 1, '6cd4b85f', '031bb015'],
  ['easy, double jump, 200 m', { difficulty: 'easy', doubleJump: true, lengthM: 200 }, 1, '3dc27a80', '0015b2b4'],
];

describe('old platform levels keep their world and hash', () => {
  it.each(PLATFORM_PINS)('%s %j seed %i', (_name, controlParams, seed, world, bot) => {
    const read = readGameSpec({ ...platformFixture, controlParams });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const made = arcadeWorldOf(read.value, seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(canonicalHash(made.world)).toBe(world);
    const run = runBot(made.world);
    expect([run.outcome, run.hash]).toEqual(['won', bot]);
  });
});
