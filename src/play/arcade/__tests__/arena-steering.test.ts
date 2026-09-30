/**
 * Řízení pronásledovatelů (P32E T2): celočíselné, stav jen ve snímku.
 *
 * Replay bez dozoru musí dát stejný hash – stav řízení schovaný mimo snímek
 * (proměnná modulu) by se při dvou hrách najednou pomíchal. Pronásledovatel
 * obejde stěnu tvaru L a dva pronásledovatelé se neslijí do jednoho bodu.
 */

import { describe, expect, it } from 'vitest';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_HZ, type ArcadeInput, type ArcadeLevel, type ArcadeWorld, BODY, type BodyInit, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../contract';
import { buildWorld, hashArcade, instantiate, loadProgram, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { ARENA, DIRECTIONS, ESCAPE, arenaAxis, arenaEscape } from '../pieces/arena';

const SEEDS = (() => {
  const rng = createCompileRng(20_260_930);
  return Array.from({ length: 50 }, () => rng.int(1, 2 ** 31 - 2));
})();

function escapeWorld(seed: number, raw: Record<string, unknown>): ArcadeWorld {
  const parts = arenaEscape.parts(seed, arenaEscape.params.parse(raw), 3);
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: 3 }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Vstup hráče: nový směr (nebo stání) každých 20 tiků, z vlastního semínka. */
function script(seed: number, ticks: number): ArcadeInput[] {
  const rng = createCompileRng(seed ^ 0x5a5a);
  const inputs: ArcadeInput[] = [];
  let axis = 0;
  for (let t = 0; t < ticks; t += 1) {
    if (t % 20 === 0) axis = rng.int(0, 4) === 0 ? 0 : arenaAxis(DIRECTIONS[rng.int(0, 31)]!.dx, DIRECTIONS[rng.int(0, 31)]!.dz);
    inputs.push({ buttons: 0, axis });
  }
  return inputs;
}

/** Hraje světy najednou, tik po tiku střídavě; vrátí hash každého. */
function lockstep(runs: readonly { world: ArcadeWorld; inputs: readonly ArcadeInput[] }[]): string[] {
  const games = runs.map(({ world }) => ({ program: loadProgram(world, ARCADE_LIBRARY), state: instantiate(world) }));
  const ticks = Math.max(...runs.map((run) => run.inputs.length));
  for (let t = 0; t < ticks; t += 1) games.forEach((game, g) => step(game.state, runs[g]!.inputs[t] ?? NO_INPUT, game.program));
  return games.map((game) => hashArcade(game.state));
}

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

const chasersOf = (state: Int32Array): number[] => [...Array(state[HEADER.bodyCount] as number).keys()].filter((i) => state[bodyBase(i) + BODY.role] === ROLE.chaser && alive(state, i));

function overlap(state: Int32Array, a: number, b: number): boolean {
  const pa = bodyBase(a);
  const pb = bodyBase(b);
  return (
    Math.abs((state[pa + BODY.x] as number) - (state[pb + BODY.x] as number)) * 2 < (state[pa + BODY.w] as number) + (state[pb + BODY.w] as number) &&
    Math.abs((state[pa + BODY.z] as number) - (state[pb + BODY.z] as number)) * 2 < (state[pa + BODY.d] as number) + (state[pb + BODY.d] as number)
  );
}

describe('chaser steering – deterministic replay', () => {
  it('the same input gives the same hash on 50 seeds, played alone or two games at once', () => {
    const ticks = 20 * ARCADE_HZ;
    const runs = SEEDS.map((seed) => ({ world: escapeWorld(seed, { chasers: 3, items: 8 }), inputs: script(seed, ticks) }));
    const alone = runs.map((run) => lockstep([run])[0]);
    for (let k = 0; k < runs.length; k += 2) {
      expect(lockstep([runs[k]!, runs[k + 1]!]), `seeds ${SEEDS[k]} + ${SEEDS[k + 1]}`).toEqual([alone[k], alone[k + 1]]);
    }
    // A pronásledovatelé se opravdu hýbou – replay nestojí na nulách.
    const state = instantiate(runs[0]!.world);
    const program = loadProgram(runs[0]!.world, ARCADE_LIBRARY);
    let moved = false;
    for (let t = 0; t < 4 * ARCADE_HZ; t += 1) {
      step(state, runs[0]!.inputs[t]!, program);
      moved ||= chasersOf(state).some((i) => state[bodyBase(i) + BODY.vx] !== 0 || state[bodyBase(i) + BODY.vz] !== 0);
    }
    expect(moved).toBe(true);
  });
});

describe('chaser steering – walls and each other', () => {
  const wall = (x: number, zz: number, w: number, d: number): BodyInit => ({ role: 'obstacle', kind: 'wall', x, y: 0, z: zz, w, h: 2000, d, solid: true });
  /** Stěna tvaru L: vodorovné rameno nad pronásledovatelem, svislé po jeho pravici – kapsa, ze které přímá cesta nevede. */
  const L = [wall(0, -2000, 6000, 1000), wall(2500, -3750, 1000, 2500)];

  function lWorld(speed: number): ArcadeWorld {
    const level: ArcadeLevel = {
      bodies: [
        { role: 'player', kind: 'player', x: 1500, y: 0, z: 3000, w: ESCAPE.playerSize, h: ARENA.height, d: ESCAPE.playerSize, solid: false },
        { role: 'chaser', kind: 'chaser', x: 800, y: 0, z: -4000, w: ESCAPE.chaserSize, h: ESCAPE.chaserHeight, d: ESCAPE.chaserSize, solid: false, kinematic: true },
        ...L,
      ],
      length: 0,
    };
    const chase = { speed, lead: ESCAPE.lead };
    const built = buildWorld(
      { seed: 1, control: { id: 'move_free', params: { half: ARENA.half, size: ESCAPE.playerSize, chase } }, rules: [{ id: 'arena_eat', params: { effect: 'lose', grace: ESCAPE.graceTicks } }], bot: { id: 'arena_bot', params: { half: ARENA.half, chase } }, level },
      ARCADE_LIBRARY,
    );
    if (!built.ok) throw new Error(built.issues.join('; '));
    return built.world;
  }

  it.each([ESCAPE.chaserSpeed.min, ESCAPE.chaserSpeed.default, ESCAPE.chaserSpeed.max])('at speed %i a chaser in the pocket of an L wall gets round it to the player within 5 s, never inside the wall', (speed) => {
    const world = lWorld(speed);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const walls = [2, 3];
    let tick = 0;
    for (; tick < 5 * ARCADE_HZ && state[HEADER.runState] === 0; tick += 1) {
      step(state, NO_INPUT, program);
      for (const w of walls) expect(overlap(state, 1, w), `tick ${tick}: the chaser is inside wall ${w}`).toBe(false);
    }
    expect(state[HEADER.runState], `not caught within 5 s (tick ${tick})`).toBe(2);
  });

  it('two chasers never overlap each other for more than 0.5 s, and never outrun their speed', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const world = escapeWorld(seed, { chasers: 4, chaserSpeed: ESCAPE.chaserSpeed.max });
      const program = loadProgram(world, ARCADE_LIBRARY);
      const state = instantiate(world);
      // Hráč krouží po aréně: pronásledovatelé se za ním řadí do zástupu, kde by se bez odstupu slili.
      const run = new Map<string, number>();
      let longest = 0;
      for (let t = 0; t < 30 * ARCADE_HZ && state[HEADER.runState] === 0; t += 1) {
        const k = Math.floor(t / 15) % 32;
        step(state, { buttons: 0, axis: arenaAxis(DIRECTIONS[k]!.dx, DIRECTIONS[k]!.dz) }, program);
        const chasers = chasersOf(state);
        for (const i of chasers) {
          const v = Math.hypot(state[bodyBase(i) + BODY.vx] as number, state[bodyBase(i) + BODY.vz] as number);
          expect(v, `seed ${seed} tick ${t}`).toBeLessThanOrEqual(ESCAPE.chaserSpeed.max + 1);
        }
        for (const a of chasers) {
          for (const b of chasers) {
            if (b <= a) continue;
            const key = `${a}:${b}`;
            const length = overlap(state, a, b) ? (run.get(key) ?? 0) + 1 : 0;
            run.set(key, length);
            longest = Math.max(longest, length);
          }
        }
      }
      expect(longest, `seed ${seed}`).toBeLessThanOrEqual(ARCADE_HZ / 2);
    }
  });
});

describe('chaser steering – bounded acceleration and pursuit lead', () => {
  it('a chaser changes speed by at most chaserAccel per tick and axis, so a turn takes time (bar a wall stopping one axis)', () => {
    const speed = ESCAPE.chaserSpeed.max;
    let steered = 0;
    for (const seed of SEEDS.slice(0, 20)) {
      const world = escapeWorld(seed, { chasers: 4, chaserSpeed: speed });
      const program = loadProgram(world, ARCADE_LIBRARY);
      const state = instantiate(world);
      const previous = new Map<number, readonly [number, number]>();
      for (let t = 0; t < 20 * ARCADE_HZ && state[HEADER.runState] === 0; t += 1) {
        // Hráč mění směr každou čtvrtsekundu naopak – pronásledovatel musí otáčet.
        const k = (Math.floor(t / 15) * 13) % 32;
        step(state, { buttons: 0, axis: arenaAxis(DIRECTIONS[k]!.dx, DIRECTIONS[k]!.dz) }, program);
        for (const i of chasersOf(state)) {
          const v = [state[bodyBase(i) + BODY.vx] as number, state[bodyBase(i) + BODY.vz] as number] as const;
          const was = previous.get(i);
          previous.set(i, v);
          if (was === undefined) continue;
          // Strop rychlosti složku po zrychlení ještě zkrátí k nule – víc než o `chaserAccel` jen tak, na stropu.
          const atCap = Math.hypot(v[0], v[1]) >= speed - 2;
          for (const axis of [0, 1]) {
            if (v[axis] === 0) continue;
            const bounded = Math.abs(v[axis]! - was[axis]!) <= ESCAPE.chaserAccel || (atCap && Math.sign(v[axis]!) === Math.sign(was[axis]!) && Math.abs(v[axis]!) < Math.abs(was[axis]!));
            expect(bounded, `seed ${seed} tick ${t} chaser ${i} axis ${axis}: ${was} → ${v}`).toBe(true);
            if (v[axis] !== was[axis]) steered += 1;
          }
        }
      }
    }
    expect(steered).toBeGreaterThan(1000);
  });

  /** Hráč běží plnou rychlostí po +x, bdělý pronásledovatel stojí 8 m za ním: o kolik směrů míří před hráče. */
  function leadAfter(lead: number, ticks: number): number {
    const chase = { speed: ESCAPE.chaserSpeed.default, lead };
    const level: ArcadeLevel = {
      bodies: [
        { role: 'player', kind: 'player', x: -8000, y: 0, z: 0, w: ESCAPE.playerSize, h: ARENA.height, d: ESCAPE.playerSize, solid: false },
        { role: 'chaser', kind: 'chaser', x: -8000, y: 0, z: -8000, w: ESCAPE.chaserSize, h: ESCAPE.chaserHeight, d: ESCAPE.chaserSize, solid: false, kinematic: true },
      ],
      length: 0,
    };
    const built = buildWorld(
      { seed: 1, control: { id: 'move_free', params: { half: ARENA.half, size: ESCAPE.playerSize, chase } }, rules: [{ id: 'arena_eat', params: { effect: 'lose', grace: ESCAPE.graceTicks } }], bot: { id: 'arena_bot', params: { half: ARENA.half, chase } }, level },
      ARCADE_LIBRARY,
    );
    if (!built.ok) throw new Error(built.issues.join('; '));
    const program = loadProgram(built.world, ARCADE_LIBRARY);
    const state = instantiate(built.world);
    const p = bodyBase(state[HEADER.player] as number);
    state[p + BODY.vx] = ARENA.speed;
    for (let t = 0; t < ticks; t += 1) step(state, { buttons: 0, axis: arenaAxis(1000, 0) }, program);
    const c = bodyBase(1);
    const bearing = Math.atan2((state[p + BODY.x] as number) - (state[c + BODY.x] as number), (state[p + BODY.z] as number) - (state[c + BODY.z] as number));
    const heading = Math.atan2(state[c + BODY.vx] as number, state[c + BODY.vz] as number);
    return ((heading - bearing) * 16) / Math.PI;
  }

  it('a chaser heads for where the running player will be, at least one direction ahead of where it is; without lead it does not', () => {
    for (const ticks of [15, 30, 45]) {
      expect(leadAfter(ESCAPE.lead, ticks), `lead after ${ticks} ticks`).toBeGreaterThanOrEqual(1);
      expect(leadAfter(0, ticks), `no lead after ${ticks} ticks`).toBeLessThan(1);
    }
  });
});
