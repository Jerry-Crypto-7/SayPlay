/**
 * Závod s triky – jádro (P68V T2): trať z řízení prodloužená o rampy a hromady, skok z rampy, náraz do mantinelu,
 * trosky z hromad s rozpočtem a despawnem.
 *
 * Mechaniku měří rovná laboratorní trať (`straightBase`) se skutečnými kusy hry (`stuntParts`, knihovna jádra) – kde
 * stojí rampa a hromada, je tam napevno, takže skok, náraz i trosky přijdou v předem známém tiku. Generovanou trať
 * hlídá `checkStuntLevel` na 200 semínkách a celý běh robota řízení.
 *
 * Test level full (plán T2): troska, jejíž impulz nebo despawn se o tik posune, hraje na první pohled stejně – testy
 * proto pinují tik nárazu (první tik průniku AABB), tik zhasnutí (`debrisLife`), znovupoužití slotu a strop živých trosek.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { STUNT_DEBRIS_MAX } from '../../genre/p68-contract';
import { type ArcadeInput, type ArcadeLevel, type ArcadeWorld, BODY, BUTTON, type BodyInit, COUNTER, FLAG, HEADER, NO_INPUT, START_LIVES, bodyBase, bodyHp } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { releasePhysics } from '../physics/step';
import { loadRapier } from '../physics/world';
import { STEER, steerSegments } from '../pieces/steer';
import { steerBot } from '../pieces/steer-bot';
import {
  STUNT,
  STUNT_BODIES,
  STUNT_SLOTS,
  type StuntLayout,
  type StuntTrackParams,
  checkStuntLevel,
  stuntCourseOf,
  stuntDebrisOf,
  stuntFlight,
  stuntParts,
  stuntTrack,
} from '../pieces/stunt';

beforeAll(async () => {
  await loadRapier();
});

// ---------------------------------------------------------------------------
// Laboratoř: rovná trať a běh se skutečnými kusy

/** Rovná trať bez zatáček: mantinely −20…400 m, šířka 10 m, cíl na 380 m. */
function straightBase(): ArcadeLevel {
  const width = 10_000;
  const wall = (x: number): BodyInit => ({ role: 'obstacle', kind: 'tire-barrier', x, y: 0, z: 190_000, w: STEER.wallW, h: STEER.wallH, d: 420_000, solid: true });
  return {
    bodies: [
      { role: 'player', kind: 'car', x: 0, y: 0, z: 0, w: STEER.carW, h: STEER.carH, d: STEER.carD, solid: false },
      wall(-(width + STEER.wallW) / 2),
      wall((width + STEER.wallW) / 2),
      { role: 'goal', kind: 'finish', x: 0, y: 0, z: 380_000, w: width, h: 3000, d: 400, solid: false },
    ],
    length: 380_000,
  };
}

const RAMP = (z0: number, x = 0) => ({ x, z0, z1: z0 + STUNT.ramp.d, w: STUNT.ramp.w, h: STUNT.ramp.h });
const PILE = (z: number, count: number, x = 0) => ({ x, z, count, kind: 'crate' });

function labWorld(layout: StuntLayout, seed = 7): ArcadeWorld {
  const parts = stuntParts(straightBase(), layout, { seed });
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: parts.health }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

type Driver = (state: Int32Array, tick: number) => ArcadeInput;

/** Běh světa `world`: `observe` dostane stav po každém tiku (a tik, který právě proběhl); vrací stav na konci. */
function drive(world: ArcadeWorld, driver: Driver, ticks: number, observe?: (state: Int32Array, tick: number, before: Int32Array) => void): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  try {
    for (let tick = 0; tick < ticks && state[HEADER.runState] === 0; tick += 1) {
      const before = state.slice();
      step(state, driver(state, tick), program);
      observe?.(state, tick, before);
    }
    return state.slice();
  } finally {
    releasePhysics(state);
  }
}

const at = (state: Int32Array, body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;
const alive = (state: Int32Array, body: number): boolean => (at(state, body, 'flags') & FLAG.alive) !== 0;
const keeperAt = (state: Int32Array, slot: keyof typeof STUNT_SLOTS): number => state[bodyBase(STUNT_BODIES.keeper) + STUNT_SLOTS[slot]] as number;
const lives = (state: Int32Array): number => state[HEADER.counters + COUNTER.health] as number;

/** Průnik AABB jako v jádře (`x/z` střed, `y` spodek, dotyk hranou není průnik) – nezávislý na kódu hry. */
function overlap(state: Int32Array, a: number, b: number): boolean {
  return (
    Math.abs(at(state, a, 'x') - at(state, b, 'x')) * 2 < at(state, a, 'w') + at(state, b, 'w') &&
    Math.abs(at(state, a, 'z') - at(state, b, 'z')) * 2 < at(state, a, 'd') + at(state, b, 'd') &&
    at(state, a, 'y') < at(state, b, 'y') + at(state, b, 'h') &&
    at(state, b, 'y') < at(state, a, 'y') + at(state, a, 'h')
  );
}

/** Indexy krabic hromad (živých od tiku 0, fyzikální) v počátečním stavu světa. */
function pileBoxes(world: ArcadeWorld): number[] {
  const state = instantiate(world);
  const out: number[] = [];
  for (let i = 0; i < (state[HEADER.spawnBase] as number); i += 1) if ((at(state, i, 'flags') & (FLAG.alive | FLAG.physics)) === (FLAG.alive | FLAG.physics)) out.push(i);
  return out;
}

const idle: Driver = () => NO_INPUT;

// ---------------------------------------------------------------------------
// Trať

const DIFFICULTIES = ['easy', 'normal', 'hard'] as const;

function paramsOf(seed: number): StuntTrackParams {
  return stuntTrack.params.parse({
    difficulty: DIFFICULTIES[seed % 3],
    lengthM: STUNT.lengthM.min + ((seed * 37) % (STUNT.lengthM.max - STUNT.lengthM.min + 1)),
    ramps: STUNT.ramps.min + (seed % 3),
    piles: STUNT.piles.min + (Math.floor(seed / 3) % 3),
    boxes: STUNT.boxes.min + (seed % 4),
    things: seed % 2 === 0 ? ['crate'] : ['crate', 'cc0-barrel'],
  });
}

describe('the stunt track (stunt_track)', () => {
  it('the same seed builds the same track and scatter table, another seed another track', () => {
    const params = stuntTrack.params.parse({});
    const a = stuntTrack.parts(5, params, undefined);
    expect(stuntTrack.parts(5, params, undefined)).toEqual(a);
    const b = stuntTrack.parts(6, params, undefined);
    expect(b.level.bodies).not.toEqual(a.level.bodies);
    const scatter = (parts: typeof a): unknown => parts.rules.find((rule) => rule.id === 'stunt_impact')?.params.scatter;
    expect(scatter(b)).not.toEqual(scatter(a));
  });

  it('holds checkStuntLevel on 200 seeds with 2–4 ramps, 2–4 piles of 3–6 boxes and the finish at the end', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const params = paramsOf(seed);
      const parts = stuntTrack.parts(seed, params, undefined);
      expect(parts.issues, `seed ${seed}`).toEqual([]);
      const { bodies } = parts.level;
      const ramps = bodies.filter((body) => body.role === 'platform' && body.kind === STUNT.kinds.ramp);
      const boxes = bodies.filter((body) => body.physics === true && body.template !== true);
      expect(ramps.length, `seed ${seed}`).toBe(params.ramps);
      expect(new Set(boxes.map((box) => box.z)).size, `seed ${seed}`).toBe(params.piles);
      expect(boxes.length).toBe(params.piles * params.boxes);
      expect(boxes.length).toBeLessThanOrEqual(STUNT_DEBRIS_MAX);
      // Hráč nikdy není fyzikální těleso; trosky se rodí z předloh od tiku 0 (Rapier se přednačte).
      expect(bodies[0]?.physics).toBeUndefined();
      expect(bodies.some((body) => body.physics === true && body.template === true)).toBe(true);
    }
  });

  it('the check is not decorative: a blocked road, a short landing and a missing ramp are reported', () => {
    const parts = stuntTrack.parts(11, stuntTrack.params.parse({}), undefined);
    const { level } = parts;
    const segments = steerSegments(level);
    // Hromada roztažená přes celou šířku silnice.
    const box = level.bodies.findIndex((body) => body.physics === true && body.template !== true);
    const host = segments.find((segment) => (level.bodies[box] as BodyInit).z > segment.near && (level.bodies[box] as BodyInit).z < segment.far);
    const blocked = level.bodies.map((body, index) => (index === box ? { ...body, x: host?.center ?? 0, w: (host?.width ?? 0) + 200 } : body));
    expect(checkStuntLevel({ ...level, bodies: blocked }).join('\n')).toMatch(/blocks the road/);
    // Rampa těsně před zatáčkou: dojezd nestačí na nejdelší skok.
    const ramp = level.bodies.findIndex((body) => body.role === 'platform');
    const bend = segments.find((segment, k) => k > 0 && segment.near > 60_000 && segment.center !== (segments[k - 1] as typeof segment).center) as (typeof segments)[number];
    const late = level.bodies.map((body, index) => (index === ramp ? { ...body, z: bend.near - 5000 } : body));
    expect(checkStuntLevel({ ...level, bodies: late }).join('\n')).toMatch(/no straight landing/);
    // Jen jedna rampa.
    const single = level.bodies.filter((body, index) => body.role !== 'platform' || index === ramp);
    expect(checkStuntLevel({ ...level, bodies: single }).join('\n')).toMatch(/ramps/);
  });
});

// ---------------------------------------------------------------------------
// Skok

describe('a ramp jump', () => {
  it('driving onto a ramp throws the car into the air and it lands without losing a life', () => {
    const world = labWorld({ ramps: [RAMP(60_000)], piles: [] });
    let apex = 0;
    let landedAt = -1;
    const end = drive(world, idle, 600, (state, tick, before) => {
      apex = Math.max(apex, at(state, 0, 'y'));
      if (at(before, 0, 'y') > 0 && at(state, 0, 'y') === 0 && landedAt < 0) landedAt = tick;
    });
    const flight = stuntFlight(STUNT.topSpeed);
    expect(keeperAt(end, 'air')).toBeGreaterThan(0);
    expect(keeperAt(end, 'air')).toBeGreaterThanOrEqual(flight.airTicks - 2);
    expect(keeperAt(end, 'jumps')).toBe(1);
    expect(apex).toBeGreaterThan(STUNT.ramp.h);
    expect(landedAt).toBeGreaterThan(0);
    expect(lives(end)).toBe(START_LIVES);
    expect(at(end, 0, 'y')).toBe(0);
  });

  it('the launch is proportional to the forward speed: a braked car flies shorter', () => {
    const world = labWorld({ ramps: [RAMP(60_000)], piles: [] });
    const full = drive(world, idle, 500);
    // Brzda od 30 m: na rampu najede asi poloviční rychlostí.
    const braked = drive(world, (state) => (at(state, 0, 'z') > 30_000 && at(state, 0, 'vz') > STUNT.topSpeed / 2 ? { buttons: BUTTON.DOWN, axis: 0 } : NO_INPUT), 500);
    expect(keeperAt(braked, 'air')).toBeGreaterThan(0);
    expect(keeperAt(braked, 'air')).toBeLessThan(keeperAt(full, 'air'));
  });
});

// ---------------------------------------------------------------------------
// Náraz

describe('a crash into the barrier', () => {
  it('steering hard into the barrier costs a life, stuns and slows the car', () => {
    const world = labWorld({ ramps: [], piles: [] });
    let crashTick = -1;
    let speedBefore = 0;
    const speeds: number[] = [];
    drive(world, (_, tick) => (tick >= 100 ? { buttons: 0, axis: 1000 } : NO_INPUT), 260, (state, tick, before) => {
      speeds[tick] = at(state, 0, 'vz');
      if (crashTick < 0 && lives(state) < lives(before)) {
        crashTick = tick;
        speedBefore = at(before, 0, 'vz');
      }
    });
    expect(crashTick).toBeGreaterThan(100);
    // Rychlost na zlomek v prvním tiku omráčení, během omráčení plyn nebere.
    const stunned = speeds[crashTick + 1] as number;
    expect(stunned).toBeLessThanOrEqual(Math.floor((speedBefore * STUNT.crash.keepPct) / 100));
    expect(speeds[crashTick + STUNT.crash.stunTicks - 2]).toBe(stunned);
    const end = drive(world, (_, tick) => (tick >= 100 ? { buttons: 0, axis: 1000 } : NO_INPUT), 260);
    expect(lives(end)).toBe(START_LIVES - 1);
  });

  it('a slow scrape along the barrier is not a crash', () => {
    const world = labWorld({ ramps: [], piles: [] });
    let touched = false;
    const end = drive(world, () => ({ buttons: 0, axis: 200 }), 400, (state) => {
      touched ||= at(state, 0, 'x') + STEER.carW / 2 >= 5000;
    });
    expect(touched).toBe(true);
    expect(lives(end)).toBe(START_LIVES);
  });

  it('three hard crashes lose the race', () => {
    const world = labWorld({ ramps: [], piles: [] });
    const zigzag: Driver = (_, tick) => (tick < 60 ? NO_INPUT : { buttons: 0, axis: Math.floor((tick - 60) / 150) % 2 === 0 ? 1000 : -1000 });
    const end = drive(world, zigzag, 1200);
    expect(lives(end)).toBe(0);
    expect(outcomeOf(end)).toBe('lost');
  });

  it('a car that only brakes runs out of time and loses', () => {
    const world = labWorld({ ramps: [], piles: [] });
    const end = drive(world, () => ({ buttons: BUTTON.DOWN, axis: 0 }), 5400);
    expect(outcomeOf(end)).toBe('lost');
    expect(lives(end)).toBe(START_LIVES);
    const limit = world.rules.find((rule) => rule.id === 'time_limit')?.params.seconds as number;
    expect(end[HEADER.tick]).toBe(limit * 60 + 1);
  });

  it('driving straight to the finish wins with the time bonus', () => {
    const world = labWorld({ ramps: [], piles: [] });
    const end = drive(world, idle, 3000);
    expect(outcomeOf(end)).toBe('won');
    expect(end[HEADER.counters + COUNTER.score]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Trosky

describe('debris from a pile', () => {
  it('the contact tick throws the pile: at least two crates move more than a metre within 30 ticks', () => {
    const world = labWorld({ ramps: [], piles: [PILE(150_000, 5)] });
    const boxes = pileBoxes(world);
    expect(boxes).toHaveLength(5);
    const start = instantiate(world);
    const source = boxes.map((box) => [at(start, box, 'x'), at(start, box, 'y'), at(start, box, 'z')] as const);
    const states: Int32Array[] = [];
    let impact = -1;
    drive(world, idle, 700, (state, tick) => {
      states[tick] = state.slice();
      if (impact < 0 && boxes.some((box) => !alive(state, box))) impact = tick;
    });
    expect(impact).toBeGreaterThan(0);
    const hit = states[impact] as Int32Array;
    const before = states[impact - 1] as Int32Array;
    // Impulz v tiku kontaktu: v tiku před ním auto žádnou krabici neprotíná, v tiku nárazu ano.
    expect(boxes.some((box) => overlap(before, 0, box))).toBe(false);
    expect(boxes.some((box) => overlap(hit, 0, box))).toBe(true);
    expect(boxes.every((box) => !alive(hit, box))).toBe(true);
    // Trosky vznikly v témže tiku s rychlostí z rychlosti auta.
    const debris = stuntDebrisOf(hit);
    expect(debris).toHaveLength(5);
    for (const body of debris) expect(at(hit, body, 'vz')).toBeGreaterThan(0);
    const later = states[impact + 30] as Int32Array;
    const moved = debris.filter((body, k) => {
      const [x, y, z] = source[k] as readonly [number, number, number];
      return Math.hypot(at(later, body, 'x') - x, at(later, body, 'y') - y, at(later, body, 'z') - z) > 1000;
    });
    expect(moved.length).toBeGreaterThanOrEqual(2);
    // Čítač `smash` a zpomalení auta o pevný podíl.
    const next = states[impact + 1] as Int32Array;
    expect(keeperAt(next, 'smash')).toBe(5);
    expect(keeperAt(next, 'impacts')).toBe(1);
    expect(at(next, 0, 'vz')).toBeLessThanOrEqual(Math.floor((at(hit, 0, 'vz') * STUNT.smash.keepPct) / 100) + STEER.accel);
    expect(lives(next)).toBe(START_LIVES);
  });

  it('without a contact the crates do not move', () => {
    const world = labWorld({ ramps: [], piles: [PILE(150_000, 6, 3200)] });
    const boxes = pileBoxes(world);
    const start = instantiate(world);
    let passed = false;
    const end = drive(world, idle, 900, (state) => {
      passed ||= at(state, 0, 'z') > 160_000;
      expect(stuntDebrisOf(state)).toHaveLength(0);
    });
    expect(passed).toBe(true);
    for (const box of boxes) {
      expect(alive(end, box)).toBe(true);
      for (const slot of ['x', 'y', 'z'] as const) expect(Math.abs(at(end, box, slot) - at(start, box, slot)), `${box}.${slot}`).toBeLessThanOrEqual(30);
    }
  });

  it('live debris never exceed debrisMax, even with two full piles hit back to back', () => {
    const world = labWorld({ ramps: [], piles: [PILE(150_000, 6), PILE(170_000, 6)] });
    let most = 0;
    drive(world, idle, 1000, (state) => {
      const live = stuntDebrisOf(state).length;
      most = Math.max(most, live);
      expect(live).toBeLessThanOrEqual(STUNT.debrisMax);
      let physics = 0;
      for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) if ((at(state, i, 'flags') & (FLAG.alive | FLAG.physics)) === (FLAG.alive | FLAG.physics)) physics += 1;
      expect(physics).toBeLessThanOrEqual(STUNT_DEBRIS_MAX);
    });
    // Rozpočet opravdu narazil na strop: druhá hromada dostala jen zbytek.
    expect(most).toBe(STUNT.debrisMax);
  });

  it('debris go dark after debrisLife ticks (FLAG.alive = 0) and the next pile reuses the slot', () => {
    const world = labWorld({ ramps: [], piles: [PILE(150_000, 4), PILE(240_000, 4)] });
    const boxes = pileBoxes(world);
    const first = boxes.slice(0, 4);
    const second = boxes.slice(4);
    const spawnBase = instantiate(world)[HEADER.spawnBase] as number;
    let impact = -1;
    let reuse = -1;
    const clock: number[] = [];
    const deaths = new Map<number, number>();
    drive(world, idle, 1300, (state, tick, before) => {
      if (impact < 0 && first.some((box) => !alive(state, box))) impact = tick;
      if (reuse < 0 && second.some((box) => !alive(state, box))) reuse = tick;
      if (impact >= 0 && reuse < 0) {
        if (alive(state, spawnBase)) clock.push(bodyHp(state, spawnBase));
        for (let i = spawnBase; i < (state[HEADER.bodyCount] as number); i += 1) if (alive(before, i) && !alive(state, i)) deaths.set(i, tick);
      }
      if (reuse === tick) {
        // Znovupoužitý slot: první troska druhé hromady leží ve slotu první trosky první hromady, s plným životem.
        expect(alive(state, spawnBase)).toBe(true);
        expect(bodyHp(state, spawnBase)).toBe(STUNT.debrisLife);
        expect(state[HEADER.bodyCount]).toBe(spawnBase + 4);
      }
    });
    expect(impact).toBeGreaterThan(0);
    expect(reuse).toBeGreaterThan(impact + STUNT.debrisLife);
    // Každá troska první hromady zhasla nejpozději v tiku nárazu + debrisLife; hodiny ubývají po tiku.
    expect([...deaths.keys()].sort((a, b) => a - b)).toEqual([spawnBase, spawnBase + 1, spawnBase + 2, spawnBase + 3]);
    for (const tick of deaths.values()) expect(tick).toBeLessThanOrEqual(impact + STUNT.debrisLife);
    expect(clock.slice(0, 3)).toEqual([STUNT.debrisLife, STUNT.debrisLife - 1, STUNT.debrisLife - 2]);
  });
});

// ---------------------------------------------------------------------------
// Celý běh

/** Řidič po ose trati (robot řízení s dokonalým vnímáním) – stačí na celý běh generované trati. */
function courseDriver(world: ArcadeWorld): Driver {
  const course = (world.bot.params as { course: ReturnType<typeof stuntCourseOf> }).course;
  const params = steerBot.params.parse({ topSpeed: STUNT.topSpeed, drift: false, course });
  return (state, tick) => steerBot.decide({ state, player: 0, tick, recent: [] }, params);
}

describe('a whole run', () => {
  it('the player never carries FLAG.physics and the debris budget holds from tick 0 to the end', () => {
    const parts = stuntTrack.parts(3, stuntTrack.params.parse({ ramps: 4, piles: 4, boxes: 6 }), undefined);
    const built = buildWorld({ seed: 3, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: parts.health }, ARCADE_LIBRARY);
    if (!built.ok) throw new Error(built.issues.join('; '));
    let ticks = 0;
    const end = drive(built.world, courseDriver(built.world), 5400, (state) => {
      ticks += 1;
      expect(at(state, 0, 'flags') & FLAG.physics).toBe(0);
      expect(stuntDebrisOf(state).length).toBeLessThanOrEqual(STUNT.debrisMax);
    });
    expect(outcomeOf(end)).not.toBe('running');
    expect(ticks).toBeGreaterThan(600);
  });
});
