/**
 * Závod s triky – replay od tiku 0 (P68V T2): dvě přehrání téhož záznamu dají týž hash a shodné kontrolní body
 * (`replayCheckpoints`) v tiku před nárazem, v tiku nárazu, po zhasnutí první trosky a po znovupoužití jejího slotu;
 * záznam posunutý o tik dá jiný hash. Troska, jejíž impulz nebo despawn se v replayi posune, by hrála na první
 * pohled stejně – tady se rozejde stav celého pole `Int32Array`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { compileGame } from '../../compile';
import { readGameSpec } from '../../spec';
import { type ArcadeInput, type ArcadeLevel, type ArcadeWorld, BODY, type BodyInit, COUNTER, FLAG, HEADER, type InputEvent, NO_INPUT, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { replayCheckpoints } from '../physics/replay-checkpoints';
import { releasePhysics } from '../physics/step';
import { loadRapier } from '../physics/world';
import { STEER } from '../pieces/steer';
import { steerBot } from '../pieces/steer-bot';
import { STUNT, STUNT_BODIES, type StuntLayout, stuntParts, stuntTrack } from '../pieces/stunt';
import { runBot } from '../verify';

beforeAll(async () => {
  await loadRapier();
});

/** Rovná trať bez zatáček: mantinely −20…400 m, šířka 10 m, cíl na 380 m (jako v `stunt.test.ts`). */
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

function worldOf(level: ArcadeLevel, layout: StuntLayout, seed: number): ArcadeWorld {
  const parts = stuntParts(level, layout, { seed });
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: parts.health }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Rampa, hromada a druhá hromada tak daleko, aby trosky první stihly zhasnout a slot se vrátil. */
const LAYOUT: StuntLayout = {
  ramps: [{ x: 0, z0: 60_000, z1: 60_000 + STUNT.ramp.d, w: STUNT.ramp.w, h: STUNT.ramp.h }],
  piles: [
    { x: 0, z: 150_000, count: 4, kind: 'crate' },
    { x: 0, z: 240_000, count: 5, kind: 'cc0-barrel' },
  ],
};

/** Záznam s drobným kličkováním: hromady na ose trati auto i tak trefí. */
const wiggle = (tick: number): ArcadeInput => (tick % 40 < 20 ? { buttons: 0, axis: 120 } : { buttons: 0, axis: -120 });

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

interface Events {
  readonly record: InputEvent[];
  /** Tik (= `HEADER.tick` před krokem), ve kterém auto narazilo do první hromady. */
  readonly impact: number;
  /** Tik, ve kterém zhasla první troska. */
  readonly despawn: number;
  /** Tik, ve kterém se její slot znovu použil pro druhou hromadu. */
  readonly reuse: number;
  readonly states: Map<number, number[]>;
}

/** Průzkumný běh: zaznamená vstupy a najde tiky událostí; `states` = stav po `HEADER.tick` krocích. */
function explore(world: ArcadeWorld, input: (tick: number) => ArcadeInput): Events {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const spawnBase = state[HEADER.spawnBase] as number;
  const boxes: number[] = [];
  for (let i = 0; i < spawnBase; i += 1) if (((state[bodyBase(i) + BODY.flags] as number) & (FLAG.alive | FLAG.physics)) === (FLAG.alive | FLAG.physics)) boxes.push(i);
  const record: InputEvent[] = [];
  const states = new Map<number, number[]>();
  let impact = -1;
  let despawn = -1;
  let reuse = -1;
  try {
    for (let tick = 0; tick < 1400 && state[HEADER.runState] === 0; tick += 1) {
      states.set(tick, Array.from(state));
      const now = input(tick);
      if (now.buttons !== 0 || now.axis !== 0) record.push({ tick, ...now });
      const firstWasAlive = alive(state, spawnBase);
      step(state, now, program);
      if (impact < 0 && boxes.slice(0, 4).some((box) => !alive(state, box))) impact = tick;
      if (impact >= 0 && despawn < 0 && firstWasAlive && !alive(state, spawnBase)) despawn = tick;
      if (despawn >= 0 && reuse < 0 && alive(state, spawnBase)) reuse = tick;
    }
    states.set(state[HEADER.tick] as number, Array.from(state));
  } finally {
    releasePhysics(state);
  }
  return { record, impact, despawn, reuse, states };
}

describe('replay from tick 0 with debris despawn and slot reuse', () => {
  const world = worldOf(straightBase(), LAYOUT, 21);
  let events: Events;
  beforeAll(() => {
    events = explore(world, wiggle);
  });

  it('the scenario has an impact, a despawn of the first debris and a reuse of its slot, in that order', () => {
    expect(events.impact).toBeGreaterThan(0);
    expect(events.despawn).toBeGreaterThan(events.impact);
    expect(events.reuse).toBeGreaterThan(events.despawn);
    expect(events.record.length).toBeGreaterThan(100);
  });

  it('two replays of the same record agree at every checkpoint, and with the recorded run', async () => {
    // Kontrolní bod `t` = stav po `t` krocích: před nárazem, po kroku nárazu, po zhasnutí první trosky, po znovupoužití slotu.
    const checkpoints = [events.impact, events.impact + 1, events.despawn + 1, events.reuse + 1];
    const first = await replayCheckpoints({ world, inputs: events.record, checkpoints });
    const second = await replayCheckpoints({ world, inputs: events.record, checkpoints });
    expect(first.map((point) => point.tick)).toEqual(checkpoints);
    expect(second).toEqual(first);
    for (const point of first) expect(point.state).toEqual(events.states.get(point.tick));
    expect(new Set(first.map((point) => point.hash)).size).toBe(checkpoints.length);
  });

  it('a record shifted by one tick gives another hash', () => {
    const original = replay(world, events.record, ARCADE_LIBRARY);
    expect(replay(world, events.record, ARCADE_LIBRARY)).toEqual(original);
    const shifted = events.record.map((event) => ({ ...event, tick: event.tick + 1 }));
    expect(replay(world, shifted, ARCADE_LIBRARY).hash).not.toBe(original.hash);
  });
});

describe('replay of a generated track', () => {
  it('two replays of a driven record on a generated track give the same hash and outcome', () => {
    const parts = stuntTrack.parts(9, stuntTrack.params.parse({}), undefined);
    expect(parts.issues).toEqual([]);
    const built = buildWorld({ seed: 9, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: parts.health }, ARCADE_LIBRARY);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const { world } = built;
    const course = (world.bot.params as { course: unknown }).course;
    const params = steerBot.params.parse({ topSpeed: STUNT.topSpeed, drift: false, course });
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const record: InputEvent[] = [];
    try {
      for (let tick = 0; tick < 5400 && state[HEADER.runState] === 0; tick += 1) {
        const input = steerBot.decide({ state, player: 0, tick, recent: [] }, params);
        if (input.buttons !== 0 || input.axis !== 0) record.push({ tick, ...input });
        step(state, input === NO_INPUT ? NO_INPUT : input, program);
      }
    } finally {
      releasePhysics(state);
    }
    const a = replay(world, record, ARCADE_LIBRARY);
    const b = replay(world, record, ARCADE_LIBRARY);
    expect(b).toEqual(a);
    expect(a.outcome).not.toBe('running');
  });
});

/**
 * Otisk pro prohlížeč (P68V T5): hra z ručního specu e2e (`e2e/fixtures/p68-stunt-spec.json`) přeložená týmž
 * kompilátorem jako server (`compileGame`), záznam robota ověřovače (`runBot`) přehraný od tiku 0. `stunt-hash.json`
 * drží Node otisk; `e2e/play-stunt.spec.ts` přehraje týž záznam v prohlížeči (`playWitness` sondy) a musí dostat týž.
 */
describe('the e2e fixture replays from tick 0 to the pinned Node hash (T5)', () => {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), 'e2e/fixtures/p68-stunt-spec.json'), 'utf8')) as { seed: number; spec: unknown };
  const pinned = JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p68/vozidla-sport/stunt-hash.json'), 'utf8')) as {
    seed: number;
    node: { hash: string; outcome: string; tick: number; inputs: number };
    moments: { jumpPeak: number; jumpLanded: number; smash: number; idleCrash: number };
  };
  let world: ArcadeWorld;
  let inputs: readonly InputEvent[];
  beforeAll(() => {
    const read = readGameSpec(fixture.spec);
    if (!read.ok) throw new Error(read.issues.join('; '));
    const compiled = compileGame(read.value, fixture.seed);
    if (!compiled.ok || compiled.value.arcade === undefined) throw new Error(compiled.ok ? 'no arcade world' : compiled.issues.join('; '));
    world = compiled.value.arcade;
    inputs = runBot(world).inputs;
  });

  it('compile → bot record → replay from tick 0 gives the hash in stunt-hash.json, twice', () => {
    const first = replay(world, inputs, ARCADE_LIBRARY);
    expect(replay(world, inputs, ARCADE_LIBRARY)).toEqual(first);
    expect(first.hash).toBe(runBot(world).hash);
    expect(first.outcome).toBe('won');
    expect(pinned.seed).toBe(fixture.seed);
    const node = { hash: first.hash, outcome: first.outcome, tick: first.tick, inputs: inputs.length };
    expect(node, `Node run ${JSON.stringify(node)}`).toEqual(pinned.node);
  }, 120_000);

  it('the screenshot moments (peak of the first jump, first pile hit, idle wall crash) are where stunt-hash.json says', () => {
    /** Tik = `HEADER.tick` po kroku – tentýž, který vrací `tickByHand` sondy. */
    const walk = (record: readonly InputEvent[]) => {
      const program = loadProgram(world, ARCADE_LIBRARY);
      const state = instantiate(world);
      const spawnBase = state[HEADER.spawnBase] as number;
      const crates: number[] = [];
      for (let i = 0; i < spawnBase; i += 1) if (((state[bodyBase(i) + BODY.flags] as number) & (FLAG.alive | FLAG.physics)) === (FLAG.alive | FLAG.physics)) crates.push(i);
      const lives = state[HEADER.counters + COUNTER.health] as number;
      let peak = { tick: -1, y: 0 };
      let jumpOver = false;
      let landed = -1;
      let smash = -1;
      let crash = -1;
      let next = 0;
      try {
        for (let tick = 0; tick < 5400 && state[HEADER.runState] === 0; tick += 1) {
          while (next < record.length && (record[next] as InputEvent).tick < tick) next += 1;
          const event = record[next];
          step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
          const y = state[bodyBase(STUNT_BODIES.player) + BODY.y] as number;
          if (!jumpOver && y > 0 && y > peak.y) peak = { tick: tick + 1, y };
          else if (!jumpOver && y <= 0 && peak.tick >= 0) {
            jumpOver = true;
            landed = tick + 1;
          }
          if (smash < 0 && crates.some((box) => !alive(state, box))) smash = tick + 1;
          if (crash < 0 && (state[HEADER.counters + COUNTER.health] as number) < lives) crash = tick + 1;
        }
      } finally {
        releasePhysics(state);
      }
      return { jumpPeak: peak.tick, peakY: peak.y, landed, smash, crash };
    };
    const bot = walk(inputs);
    const idle = walk([]);
    // Vrchol skoku je nad rampou (výška 1,5 m), auto pak dopadne; robot trefí hromadu; nečinné auto narazí do mantinelu.
    expect(bot.peakY).toBeGreaterThan(STUNT.ramp.h);
    expect(bot.landed).toBeGreaterThan(bot.jumpPeak);
    expect(bot.smash).toBeGreaterThan(0);
    expect(idle.crash).toBeGreaterThan(0);
    const moments = { jumpPeak: bot.jumpPeak, jumpLanded: bot.landed, smash: bot.smash, idleCrash: idle.crash };
    expect(moments, `moments ${JSON.stringify(moments)}`).toEqual(pinned.moments);
  }, 120_000);
});
