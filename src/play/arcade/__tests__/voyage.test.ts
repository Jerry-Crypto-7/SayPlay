/**
 * Plavba a přistání (P32F T1): závod branami k pokladu mezi ostrovy a měkké
 * přistání rakety. Pirátská loď dřív jela jako auto po silnici a „přistaň“
 * nešlo vůbec – tyhle testy drží, že oba režimy jsou hra, kterou robot dohraje
 * a nečinný hráč ne, že přistání soudí rychlost a náklon, a že starý závod
 * `steer` má dál tentýž svět i hash.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';
import { readGameSpec } from '@/play/spec';

import steerFixture from '../__fixtures__/steer.json';
import { arcadeWorldOf, compileArcade } from '../compile';
import { type ArcadeWorld, BODY, BUTTON, COUNTER, FLAG, HEADER, type ModeParts, NO_INPUT, ROLE, RUN_STATE, bodyBase } from '../contract';
import { GRAVITY, buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { LAND, STEER, STEER_DIFFICULTIES, VOYAGE, steerSegments, voyageLand, voyageRace } from '../pieces/steer';
import { runBot } from '../verify';

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const difficultyOf = (seed: number) => STEER_DIFFICULTIES[seed % STEER_DIFFICULTIES.length] as (typeof STEER_DIFFICULTIES)[number];

function worldOf(parts: ModeParts, seed: number): ArcadeWorld {
  if (parts.issues !== undefined && parts.issues.length > 0) throw new Error(parts.issues.join('; '));
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, ...(parts.health === undefined ? {} : { health: parts.health }) }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const raceParts = (seed: number, extra: Record<string, unknown> = {}) => voyageRace.parts(seed, voyageRace.params.parse({ difficulty: difficultyOf(seed), ...extra }), undefined);
const landParts = (seed: number, extra: Record<string, unknown> = {}) => voyageLand.parts(seed, voyageLand.params.parse({ difficulty: difficultyOf(seed), ...extra }), undefined);

describe('voyage.race – gates between islands to the treasure', () => {
  it('builds a channel of islands with gates across it, hazards inside it and the treasure at its end', () => {
    for (const seed of [1, 2, 3]) {
      const { level, rules } = raceParts(seed);
      const segments = steerSegments(level);
      expect(segments.length).toBeGreaterThan(3);
      expect(level.bodies.filter((body) => body.role === 'obstacle').every((body) => body.kind === 'island')).toBe(true);
      const gates = level.bodies.filter((body) => body.role === 'checkpoint');
      expect(gates.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      for (const gate of gates) {
        const lane = segments.find((s) => gate.z > s.near && gate.z < s.far);
        expect(lane !== undefined && gate.w >= lane.width, `gate at ${gate.z}`).toBe(true);
      }
      const hazards = level.bodies.filter((body) => body.role === 'hazard');
      expect(hazards.some((body) => body.kinematic === true && (body.period ?? 0) > 0), 'a moving shot').toBe(true);
      for (const hazard of hazards) {
        const lane = segments.find((s) => hazard.z > s.near && hazard.z < s.far);
        expect(lane, `hazard at ${hazard.z}`).toBeDefined();
        const reach = hazard.kinematic === true ? (hazard.vx ?? 0) * (hazard.period ?? 0) : 0;
        for (const x of [hazard.x, hazard.x + reach]) expect(Math.abs(x - lane!.center) * 2 + hazard.w, `hazard at ${hazard.z} stays in the channel`).toBeLessThanOrEqual(lane!.width);
      }
      const goal = level.bodies.find((body) => body.role === 'goal');
      expect(goal?.z).toBe(level.length);
      expect(rules.map((rule) => rule.id)).toEqual(expect.arrayContaining(['hit', 'out_of_health', 'finish', 'checkpoint', 'time_limit']));
    }
  });

  it('streets and canyons: the terrain names the walls', () => {
    expect(new Set(raceParts(4, { terrain: 'buildings' }).level.bodies.filter((b) => b.role === 'obstacle').map((b) => b.kind))).toEqual(new Set(['building']));
    expect(new Set(raceParts(4, { terrain: 'rocks' }).level.bodies.filter((b) => b.role === 'obstacle').map((b) => b.kind))).toEqual(new Set(['rock']));
  });

  it('the bot wins at least 90 % of 200 seeds, easy to hard', () => {
    const lost: string[] = [];
    for (const seed of SEEDS) {
      const bot = runBot(worldOf(raceParts(seed), seed));
      if (bot.outcome !== 'won') lost.push(`${seed}:${bot.outcome}@${bot.tick}`);
    }
    expect(lost.length, lost.join(' ')).toBeLessThanOrEqual(SEEDS.length / 10);
  }, 240_000);

  it('an idle player never wins – it runs aground in the first bend and the clock runs out', () => {
    for (const seed of SEEDS.slice(0, 40)) expect(replay(worldOf(raceParts(seed), seed), [], ARCADE_LIBRARY).outcome, `seed ${seed}`).toBe('lost');
  });

  it('a shot costs a life and disappears; the third one sinks the ship', () => {
    const world = worldOf(raceParts(1), 1);
    const state = instantiate(world);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const p = bodyBase(0);
    const shots: number[] = [];
    for (let i = 1; i < (state[HEADER.bodyCount] as number) && shots.length < 3; i += 1) if (state[bodyBase(i) + BODY.role] === ROLE.hazard) shots.push(i);
    expect(shots.length).toBe(3);
    const lives: number[] = [];
    for (const shot of shots) {
      // Střela přímo na lodi: kontakt v příštím tiku.
      state[p + BODY.x] = state[bodyBase(shot) + BODY.x] as number;
      state[p + BODY.z] = state[bodyBase(shot) + BODY.z] as number;
      step(state, NO_INPUT, program);
      lives.push(state[HEADER.counters + COUNTER.health] as number);
      expect((state[bodyBase(shot) + BODY.flags] as number) & FLAG.alive).toBe(0);
    }
    expect(lives).toEqual([VOYAGE.lives - 1, VOYAGE.lives - 2, VOYAGE.lives - 3]);
    expect(state[HEADER.runState]).toBe(RUN_STATE.lost);
  });
});

describe('voyage.land – soft landing on the pad', () => {
  it('the bot lands softly on at least 90 % of 200 seeds, easy to hard', () => {
    const lost: string[] = [];
    for (const seed of SEEDS) {
      const bot = runBot(worldOf(landParts(seed), seed));
      if (bot.outcome !== 'won') lost.push(`${seed}:${bot.outcome}@${bot.tick}`);
    }
    expect(lost.length, lost.join(' ')).toBeLessThanOrEqual(SEEDS.length / 10);
  }, 120_000);

  it('free fall is a crash on every seed', () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const idle = replay(worldOf(landParts(seed), seed), [], ARCADE_LIBRARY);
      expect(idle.outcome, `seed ${seed}`).toBe('lost');
      // Pád trvá: hráč má čas zareagovat, prohra není hned po startu.
      expect(idle.tick, `seed ${seed}`).toBeGreaterThan(2 * 60);
    }
  });

  it('holding thrust upright climbs, so the craft can stop a fall', () => {
    const world = worldOf(landParts(1), 1);
    const state = instantiate(world);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const p = bodyBase(0);
    const y0 = state[p + BODY.y] as number;
    for (let i = 0; i < 120; i += 1) step(state, { buttons: BUTTON.HOLD, axis: 0 }, program);
    expect(state[p + BODY.y]).toBeGreaterThan(y0);
    expect(state[p + BODY.vy]).toBeGreaterThan(0);
  });

  /**
   * Dotyk rozhoduje: 2 m nad plochou s danou rychlostí sestupu `descent`,
   * náklonem `tilt` a boční rychlostí `vx`, pak tiky bez vstupu do dotyku.
   * Náklon bez vstupu dojíždí k nule o `tiltRate` za tik – proto se měří
   * náklon, se kterým loď opravdu dosedne (`tilt` zadaný o to větší).
   */
  function touchdown(options: { readonly descent: number; readonly tilt?: number; readonly vx?: number; readonly offPad?: boolean }): 'won' | 'lost' | 'running' {
    const parts = landParts(2, { difficulty: 'normal' });
    const world = worldOf(parts, 2);
    const state = instantiate(world);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const pad = parts.level.bodies.find((body) => body.role === 'goal')!;
    const p = bodyBase(0);
    const top = pad.y + pad.h;
    state[p + BODY.x] = options.offPad === true ? pad.x + pad.w : pad.x;
    state[p + BODY.y] = top + 30;
    // Po ovládání a gravitaci jádra klesne o `descent` (+ čistá gravitace tiku).
    state[p + BODY.vy] = -options.descent;
    state[p + BODY.vx] = options.vx ?? 0;
    state[p + BODY.aux0] = options.tilt ?? 0;
    // Mimo plochu padá dál až na zem – pár desítek tiků.
    for (let i = 0; i < 60 && state[HEADER.runState] === RUN_STATE.running; i += 1) step(state, NO_INPUT, program);
    return state[HEADER.runState] === RUN_STATE.won ? 'won' : state[HEADER.runState] === RUN_STATE.lost ? 'lost' : 'running';
  }

  it('a soft, level touchdown on the pad wins; too fast, too tilted, sliding or beside the pad loses', () => {
    const soft = LAND.tiers.normal.softVy;
    expect(touchdown({ descent: soft - 15 })).toBe('won');
    expect(touchdown({ descent: soft + 15 })).toBe('lost');
    expect(touchdown({ descent: 400 })).toBe('lost');
    expect(touchdown({ descent: soft - 15, tilt: LAND.tiers.normal.softTilt + LAND.tiltRate + 4 })).toBe('lost');
    expect(touchdown({ descent: soft - 15, tilt: LAND.tiers.normal.softTilt - 3 })).toBe('won');
    expect(touchdown({ descent: soft - 15, vx: LAND.tiers.normal.softVx + 20 })).toBe('lost');
    expect(touchdown({ descent: soft - 15, offPad: true })).toBe('lost');
  });

  it('the net fall is the planet gravity, not the jump gravity of the kernel', () => {
    const world = worldOf(landParts(3, { gravity: 1000 }), 3);
    const state = instantiate(world);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const p = bodyBase(0);
    const vy0 = state[p + BODY.vy] as number;
    for (let i = 0; i < 100; i += 1) step(state, NO_INPUT, program);
    // 100 tiků po 1,0 jednotky/tik², ne po GRAVITY = 8.
    expect(vy0 - (state[p + BODY.vy] as number)).toBe(100);
    expect(GRAVITY).toBe(8);
  });
});

describe('voyage through the compiler', () => {
  const base = { ...steerFixture, roles: steerFixture.roles.filter((role) => role.id !== 'rival') };

  it.each([
    ['voyage_race', { difficulty: 'easy', lengthM: 300, tuning: { terrain: 'islands' } }],
    ['voyage_land', { difficulty: 'easy', tuning: { gravity: 1200 } }],
  ] as const)('a steer spec delegating to %s compiles and the bot wins', (generator, params) => {
    const read = readGameSpec({ ...base, controlParams: { generator, ...params } });
    if (!read.ok) throw new Error(read.issues.join('; '));
    let compiled = compileArcade(read.value, 1);
    for (let seed = 2; seed <= 4 && !compiled.ok; seed += 1) compiled = compileArcade(read.value, seed);
    expect(compiled.ok ? 'ok' : compiled.issues.join('; ')).toBe('ok');
  });

  it('a voyage key the mode does not know is refused by the mode schema', () => {
    const read = readGameSpec({ ...base, controlParams: { generator: 'voyage_land', tuning: { wobble: 3 } } });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const made = arcadeWorldOf(read.value, 1);
    expect(!made.ok && made.issues.join(' ')).toMatch(/generator voyage_land/);
  });
});

/**
 * Svět a robotův hash dnešních závodů (29. 9. 2026, před P32F): fixtura
 * `steer.json` a varianty přes obtížnost, délku, soupeře a smyk. Nová pole
 * ovládání, robota a pravidla `rival_finish` je nesmí pohnout.
 */
const STEER_PINS: readonly (readonly [string, Record<string, unknown>, number, string, string])[] = [
  ['steer.json', steerFixture.controlParams, 1, '3d7b7ab5', '50dc21f3'],
  ['steer.json', steerFixture.controlParams, 2, 'a146952d', '81208d13'],
  ['steer.json', steerFixture.controlParams, 3, '9331b3c6', 'cbb4ca89'],
  ['easy 800 m', { difficulty: 'easy', lengthM: 800 }, 1, '23c33d88', '6a0f72ed'],
  ['easy 800 m', { difficulty: 'easy', lengthM: 800 }, 3, 'ce0f6f85', '42673315'],
  ['hard, no rivals, drift', { difficulty: 'hard', rivals: false, drift: true }, 2, '9465974f', 'c3cb9d89'],
];

describe('old steer races keep their world and hash', () => {
  it.each(STEER_PINS)('%s seed %i', (_name, controlParams, seed, world, bot) => {
    const read = readGameSpec({ ...steerFixture, controlParams });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const made = arcadeWorldOf(read.value, seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(canonicalHash(made.world)).toBe(world);
    const run = runBot(made.world);
    expect([run.outcome, run.hash]).toEqual(['won', bot]);
  });

  it('steer control params without land or dodge behave as before', () => {
    expect(STEER.topSpeed).toBe(300);
    expect(ARCADE_LIBRARY.rules.rival_finish?.params.safeParse({ atZ: 5000 }).success).toBe(true);
  });
});
