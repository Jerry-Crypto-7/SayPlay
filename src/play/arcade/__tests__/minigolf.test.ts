/**
 * Minigolf (P68 T6): jamka řešitelná konstrukcí, rána se sémantikou `ballControl`, celočíselné kutálení k zastavení,
 * odraz od mantinelu, jamka s prahem rychlosti, mimo dráhu, rány a par.
 */
import { describe, expect, it } from 'vitest';

import { ARCADE_LIMITS, type ArcadeState, type ArcadeWorld, BODY, BUTTON, type BodyInit, HEADER, type InputEvent, NO_INPUT, bodyBase } from '../contract';
import { type ArcadeProgram, buildWorld, instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { MINIGOLF_COUNTER, minigolfParts, minigolfPartsOf, minigolfScore, outOfBoundsOf, parOf, strokesOf } from '../pieces/minigolf';
import { MINIGOLF_PAR, MINIGOLF_SHAPES, type MinigolfCourse, checkMinigolfHole, minigolfLevelOf, minigolfMoverAt } from '../pieces/minigolf-hole';
import { MINIGOLF, minigolfAim, minigolfAxisToward, minigolfChargeFor, minigolfDamp, minigolfDistance, minigolfRest, minigolfShot } from '../pieces/minigolf-roll';

type Parts = ReturnType<typeof minigolfParts>;

function worldOf(parts: Parts): ArcadeWorld {
  const built = buildWorld({ seed: 1, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Ruka hráče: `HOLD` s osou `charge` tiků, pak puštění `TAP` s toutéž osou (jako `ball-input`). */
const stroke = (tick: number, axis: number, charge: number): InputEvent[] => [
  ...Array.from({ length: charge }, (_, k) => ({ tick: tick + k, buttons: BUTTON.HOLD, axis })),
  { tick: tick + charge, buttons: BUTTON.TAP, axis },
];

interface Ball {
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
}

class Run {
  readonly state: ArcadeState;
  private readonly program: ArcadeProgram;
  private readonly inputs: Map<number, InputEvent>;
  constructor(world: ArcadeWorld, inputs: readonly InputEvent[] = []) {
    this.state = instantiate(world);
    this.program = loadProgram(world, ARCADE_LIBRARY);
    this.inputs = new Map(inputs.map((event) => [event.tick, event]));
  }
  get tick(): number {
    return this.state[HEADER.tick] as number;
  }
  get outcome(): string {
    return outcomeOf(this.state);
  }
  ball(): Ball {
    const p = bodyBase(0);
    return { x: this.state[p + BODY.x] as number, z: this.state[p + BODY.z] as number, vx: this.state[p + BODY.vx] as number, vz: this.state[p + BODY.vz] as number };
  }
  /** Jeden tik se vstupem ze záznamu. */
  next(): this {
    step(this.state, this.inputs.get(this.tick) ?? NO_INPUT, this.program);
    return this;
  }
  /** Do tiku `tick` (stav po `tick` krocích) nebo konce běhu; `each` po každém kroku. */
  until(tick: number, each?: (run: this) => void): this {
    while (this.tick < tick && this.outcome === 'running') {
      this.next();
      each?.(this);
    }
    return this;
  }
}

/** Ruční dráha: rovná chodba čtyř dlaždic, odpaliště vzadu, jamka stranou od osy (ať ji rovné rány minou). */
const lane = (over: Partial<MinigolfCourse> = {}): MinigolfCourse => ({
  shape: 'straight',
  tiles: [[0, 0], [0, 1], [0, 2], [0, 3]],
  tee: [0, -1000],
  hole: [1200, 6000],
  bumpers: [],
  mover: null,
  route: [[1200, 6000]],
  par: 2,
  obstacles: 0,
  ...over,
});
const laneWorld = (over: Partial<MinigolfCourse> = {}): ArcadeWorld => worldOf(minigolfPartsOf(lane(over)));
/** Vnitřní líce mantinelů chodby: střed míčku smí mezi ně. */
const INNER = MINIGOLF.tile / 2 - MINIGOLF.ball / 2;
const resting = (ball: Ball): boolean => ball.vx === 0 && ball.vz === 0;

describe('the minigolf hole generator', () => {
  it('draws the same hole for the same seed and another hole for another seed', () => {
    expect(minigolfParts(7, {})).toEqual(minigolfParts(7, {}));
    expect(minigolfParts(7, { shape: 'S', moving: true })).toEqual(minigolfParts(7, { shape: 'S', moving: true }));
    const holes = new Set(Array.from({ length: 30 }, (_, seed) => JSON.stringify(minigolfParts(seed + 1, {}).level)));
    expect(holes.size).toBeGreaterThanOrEqual(29);
  });

  it('builds a solvable hole on 200 seeds: route of 1–3 free legs ending in the hole, par by shape', () => {
    const pars = new Set<number>();
    for (let seed = 1; seed <= 200; seed += 1) {
      const parts = minigolfParts(seed, { moving: seed % 2 === 0 });
      expect(parts.issues, `seed ${seed}`).toEqual([]);
      const world = worldOf(parts);
      const layout = (parts.control.params as { layout: { hole: number; route: [number, number][] } }).layout;
      const hole = parts.level.bodies[layout.hole] as BodyInit;
      expect(layout.route.length).toBeGreaterThanOrEqual(1);
      expect(layout.route.length).toBeLessThanOrEqual(3);
      expect(layout.route.at(-1)).toEqual([hole.x, hole.z]);
      const par = parOf(instantiate(world));
      expect([2, 3, 4]).toContain(par);
      expect(par).toBe(layout.route.length + 1);
      pars.add(par);
    }
    expect([...pars].sort()).toEqual([2, 3, 4]);
  });

  it('honours every shape, 1–3 obstacles and the moving obstacle', () => {
    for (const shape of MINIGOLF_SHAPES) {
      for (const obstacles of [1, 2, 3]) {
        for (const moving of [false, true]) {
          for (let seed = 1; seed <= 12; seed += 1) {
            const parts = minigolfParts(seed, { shape, obstacles, moving });
            expect(parts.issues, `${shape} ${obstacles} ${String(moving)} seed ${seed}`).toEqual([]);
            const layout = (parts.control.params as { layout: { bumpers: [number, number]; mover?: number } }).layout;
            expect(layout.bumpers[1]).toBe(obstacles);
            expect(layout.mover !== undefined).toBe(moving);
            expect(parts.level.counters?.reserve).toBe(MINIGOLF_PAR[shape]);
          }
        }
      }
    }
  });

  it('flags a blocked route, a hole off the route end, a leg too long for one stroke and a mover that never clears', () => {
    const parts = minigolfParts(3, { shape: 'straight', obstacles: 1, moving: false });
    const layout = (parts.control.params as { layout: Parameters<typeof checkMinigolfHole>[1] }).layout;
    expect(checkMinigolfHole(parts.level, layout)).toEqual([]);
    const tee = parts.level.bodies[0] as BodyInit;
    const [hx, hz] = layout.route.at(-1) as [number, number];
    const bodies = [...parts.level.bodies];
    const bumper = layout.bumpers[0];
    bodies[bumper] = { ...(bodies[bumper] as BodyInit), x: Math.trunc((tee.x + hx) / 2), z: Math.trunc((tee.z + hz) / 2) };
    expect(checkMinigolfHole({ ...parts.level, bodies }, layout).join(' ')).toMatch(/blocked/);
    expect(checkMinigolfHole(parts.level, { ...layout, route: [[hx + 900, hz]] }).join(' ')).toMatch(/hole/);
    const long = minigolfLevelOf(lane({ tiles: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]], hole: [0, 16000], route: [[0, 16000]] }));
    expect(checkMinigolfHole(long.level, long.layout).join(' ')).toMatch(/one stroke/);
    const wall = minigolfLevelOf(lane({ mover: { x: 0, z: 4000, w: MINIGOLF.tile, d: 600, vx: 10, vz: 0, period: 10 }, hole: [0, 9000], route: [[0, 9000]] }));
    expect(checkMinigolfHole(wall.level, wall.layout).join(' ')).toMatch(/moving/);
  });
});

describe('a putt with the ball control', () => {
  it('rolls the ball the way the axis points and rests within stopTicks exactly where the roll formula says', () => {
    for (const [axis, charge] of [[0, 30], [120, 30], [-120, 30], [-40, 45]] as const) {
      const run = new Run(laneWorld(), stroke(0, axis, charge));
      run.until(charge + 1);
      const first = run.ball();
      expect(Math.sign(first.vx)).toBe(Math.sign(axis));
      expect(first.vz).toBeGreaterThan(0);
      const [dx, dz] = minigolfAim(axis);
      // Směr rychlosti = směr osy (křížový součin do zaokrouhlení).
      expect(Math.abs(first.vx * dz - first.vz * dx)).toBeLessThanOrEqual(2 * Math.abs(dz) + 2 * Math.abs(dx));
      run.until(charge + 1 + MINIGOLF.stopTicks);
      expect(resting(run.ball())).toBe(true);
      const rest = minigolfRest(axis, charge);
      expect([run.ball().x, run.ball().z]).toEqual([rest.dx, -1000 + rest.dz]);
      expect(rest.ticks).toBeLessThanOrEqual(MINIGOLF.stopTicks);
      expect(strokesOf(run.state)).toBe(1);
    }
  });

  it('rests a full-power putt within stopTicks after the exact closed-form distance', () => {
    const run = new Run(laneWorld(), stroke(0, 0, 60));
    let restAt = -1;
    run.until(61 + MINIGOLF.stopTicks, (r) => {
      if (restAt < 0 && r.tick > 61 && resting(r.ball())) restAt = r.tick;
    });
    expect(restAt - 61).toBeLessThanOrEqual(MINIGOLF.stopTicks);
    expect(run.ball()).toEqual({ x: 0, z: -1000 + minigolfDistance(60), vx: 0, vz: 0 });
    expect(minigolfDistance(60)).toBe(14_520);
    expect(minigolfRest(0, 60)).toEqual({ dx: 0, dz: 14_520, ticks: 120 });
  });

  it('bounces off a rail it meets below the hop speed', () => {
    const run = new Run(laneWorld(), stroke(0, 250, 40));
    let right = false;
    let back = false;
    let maxX = 0;
    run.until(41 + MINIGOLF.stopTicks, (r) => {
      const ball = r.ball();
      maxX = Math.max(maxX, ball.x);
      if (ball.vx > 0) right = true;
      if (right && ball.vx < 0) back = true;
    });
    expect(right && back).toBe(true);
    expect(maxX).toBeLessThanOrEqual(INNER);
    expect(resting(run.ball())).toBe(true);
    expect(strokesOf(run.state)).toBe(1);
    expect(outOfBoundsOf(run.state)).toBe(0);
  });

  it('rolls a fast ball over the hole and drops a slow one in', () => {
    const over = { hole: [0, 6000] as const, route: [[0, 6000]] as [number, number][] };
    const fast = new Run(laneWorld(over), stroke(0, 0, 60));
    let crossed = 0;
    fast.until(61 + MINIGOLF.stopTicks, (r) => {
      const ball = r.ball();
      if (Math.abs(ball.z - 6000) * 2 < MINIGOLF.holeSize && ball.x === 0) {
        crossed += 1;
        expect(Math.hypot(ball.vx, ball.vz)).toBeGreaterThan(MINIGOLF.holeSpeed);
        expect(r.outcome).toBe('running');
      }
    });
    expect(crossed).toBeGreaterThan(0);
    expect(fast.outcome).toBe('running');
    expect(fast.ball().z).toBeGreaterThan(6000 + MINIGOLF.holeSize / 2);

    const charge = minigolfChargeFor(0, 7000);
    const slow = new Run(laneWorld(over), stroke(0, 0, charge));
    slow.until(charge + 1 + MINIGOLF.stopTicks);
    expect(slow.outcome).toBe('won');
    expect(strokesOf(slow.state)).toBe(1);
    expect(slow.state[HEADER.counters + 0]).toBe(minigolfScore(2, 1));
  });

  it('ignores a release while the ball still rolls: no stroke, the roll goes on unchanged', () => {
    const once = new Run(laneWorld(), stroke(0, 0, 40));
    const twice = new Run(laneWorld(), [...stroke(0, 0, 40), ...stroke(60, 300, 20)]);
    once.until(41);
    twice.until(41);
    expect(resting(twice.ball())).toBe(false);
    for (let tick = 41; tick < 41 + MINIGOLF.stopTicks; tick += 1) {
      once.next();
      twice.next();
      expect(twice.ball()).toEqual(once.ball());
    }
    expect(strokesOf(twice.state)).toBe(1);
    expect(twice.state[bodyBase(0) + BODY.aux1]).toBe(0);
  });

  it('returns a ball that hops the rail to the spot of the last stroke and adds a stroke', () => {
    const run = new Run(laneWorld(), [...stroke(0, 0, 30), ...stroke(150, 500, 60)]);
    run.until(150);
    const spot = run.ball();
    expect(resting(spot)).toBe(true);
    expect(minigolfShot(500, 60)[0]).toBeGreaterThan(MINIGOLF.hopSpeed);
    run.until(211 + 30);
    expect(run.ball()).toEqual({ x: spot.x, z: spot.z, vx: 0, vz: 0 });
    expect(strokesOf(run.state)).toBe(3);
    expect(outOfBoundsOf(run.state)).toBe(1);
    expect(run.outcome).toBe('running');
  });

  it('loses when the strokes run out, loses on the clock, wins in the hole with a par − strokes score', () => {
    const limit = 2 + MINIGOLF.extraStrokes;
    const weak = Array.from({ length: limit }, (_, k) => stroke(k * 10, 0, 1)).flat();
    const out = new Run(laneWorld(), weak);
    out.until((limit - 1) * 10);
    expect(out.outcome).toBe('running');
    out.until((limit - 1) * 10 + 20);
    expect(out.outcome).toBe('lost');
    expect(strokesOf(out.state)).toBe(limit);

    const idle = new Run(laneWorld());
    idle.until(ARCADE_LIMITS.maxTicks - 2);
    expect(idle.outcome).toBe('running');
    idle.until(ARCADE_LIMITS.maxTicks);
    expect(idle.outcome).toBe('lost');
    expect(idle.tick).toBe(ARCADE_LIMITS.maxTicks);

    expect(minigolfScore(3, 1)).toBeGreaterThan(minigolfScore(3, 3));
    expect(minigolfScore(3, 3)).toBeGreaterThan(minigolfScore(3, 3 + MINIGOLF.extraStrokes));
    expect(minigolfScore(3, 3 + MINIGOLF.extraStrokes)).toBeGreaterThan(0);
    expect(MINIGOLF_COUNTER).toEqual({ strokes: 'ammo', par: 'reserve', outOfBounds: 'items' });
  });
});

describe('the moving obstacle', () => {
  const mover = { x: -1000, z: 4000, w: 1000, d: 600, vx: 40, vz: 0, period: 50 } as const;

  it('moves in ticks along its period, as the closed form says', () => {
    const world = laneWorld({ mover, hole: [1200, 9000], route: [[1200, 9000]] });
    const run = new Run(world);
    const at = bodyBase(minigolfLevelOf(lane({ mover })).layout.mover as number);
    const xs = new Set<number>();
    run.until(6 * mover.period, (r) => {
      expect([r.state[at + BODY.x], r.state[at + BODY.z]]).toEqual(minigolfMoverAt(mover, r.tick));
      xs.add(r.state[at + BODY.x] as number);
    });
    expect(Math.min(...xs)).toBe(mover.x);
    expect(Math.max(...xs)).toBe(mover.x + mover.vx * mover.period);
  });

  it('knocks a resting ball without ever overlapping it', () => {
    const world = laneWorld({ mover, tee: [0, 4000], hole: [1200, 9000], route: [[1200, 9000]] });
    const at = bodyBase(minigolfLevelOf(lane({ mover })).layout.mover as number);
    const run = new Run(world);
    let moved = false;
    run.until(400, (r) => {
      const ball = r.ball();
      if (ball.x !== 0) moved = true;
      const mx = r.state[at + BODY.x] as number;
      const mz = r.state[at + BODY.z] as number;
      const overlaps = Math.abs(ball.x - mx) * 2 < mover.w + MINIGOLF.ball && Math.abs(ball.z - mz) * 2 < mover.d + MINIGOLF.ball;
      expect(overlaps).toBe(false);
      expect(Math.abs(ball.x)).toBeLessThanOrEqual(INNER);
    });
    expect(moved).toBe(true);
    expect(outOfBoundsOf(run.state)).toBe(0);
    expect(strokesOf(run.state)).toBe(0);
  });
});

describe('the integer roll', () => {
  it('damps in integers and always slows down', () => {
    for (let vx = -300; vx <= 300; vx += 7) {
      for (let vz = -300; vz <= 300; vz += 11) {
        const [nx, nz] = minigolfDamp(vx, vz);
        expect(Number.isInteger(nx) && Number.isInteger(nz)).toBe(true);
        if (vx !== 0 || vz !== 0) expect(nx * nx + nz * nz).toBeLessThan(vx * vx + vz * vz);
      }
    }
    for (let charge = 1; charge <= 60; charge += 1) expect(minigolfRest(0, charge).dz).toBe(minigolfDistance(charge));
  });

  it('maps the axis to a direction and back', () => {
    for (let axis = -1000; axis <= 1000; axis += 1) {
      const [dx, dz] = minigolfAim(axis);
      const back = minigolfAxisToward(dx, dz);
      expect(Math.abs(back) === 1000 && Math.abs(axis) === 1000 ? 1000 : back).toBe(Math.abs(back) === 1000 && Math.abs(axis) === 1000 ? 1000 : axis);
    }
    expect(minigolfAim(0)[0]).toBe(0);
    expect(minigolfAim(500)[1]).toBe(0);
    expect(minigolfAxisToward(0, 5)).toBe(0);
    expect(minigolfAxisToward(-7, 0)).toBe(-500);
  });

  it('picks the smallest charge that rolls at least the distance', () => {
    for (const distance of [500, 3000, 7000, 14_000]) {
      const charge = minigolfChargeFor(0, distance);
      expect(minigolfDistance(charge)).toBeGreaterThanOrEqual(distance);
      if (charge > 1) expect(minigolfDistance(charge - 1)).toBeLessThan(distance);
    }
    const [dx, dz] = minigolfAim(250);
    const charge = minigolfChargeFor(250, 5000);
    const rest = minigolfRest(250, charge);
    expect(rest.dx * rest.dx + rest.dz * rest.dz).toBeGreaterThanOrEqual(5000 * 5000);
    expect(Math.sign(rest.dx)).toBe(Math.sign(dx));
    expect(Math.sign(rest.dz)).toBe(Math.sign(dz));
  });
});
