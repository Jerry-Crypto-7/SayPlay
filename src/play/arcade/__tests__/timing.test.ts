import { describe, expect, it } from 'vitest';

import { type GameSpecV1, readGameSpec } from '../../spec';
import flapFixture from '../__fixtures__/flap.json';
import { arcadeWorldOf, compileArcade } from '../compile';
import { type ArcadeLevel, type ArcadeWorld, BODY, BUTTON, COUNTER, FLAG, HEADER, type InputEvent, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import {
  TIMING,
  TIMING_MODES,
  TIMING_SLOTS,
  TIMING_SPEEDS,
  type TimingLevelParams,
  type TimingMode,
  type TimingSpeed,
  checkTimingLevel,
  timingLevel,
  timingPeriod,
  timingRules,
  timingWindowTicks,
} from '../pieces/timing';
import { runBot, verifyArcade } from '../verify';

const params = (speed: TimingSpeed, extra: Partial<TimingLevelParams> = {}): TimingLevelParams => timingLevel.params.parse({ speed, ...extra });

function worldOf(level: ArcadeLevel, mode: TimingMode, health?: number): ArcadeWorld {
  const rounds = level.bodies.length - TIMING_SLOTS.marks;
  const built = buildWorld(
    { seed: 1, control: { id: 'timing', params: { mode, rounds } }, rules: timingRules(rounds, health), bot: { id: 'timing_bot', params: {} }, level, ...(health === undefined ? {} : { health }) },
    ARCADE_LIBRARY,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Tik, ve kterém je jezdec kola (od `from`) přesně ve středu: půl kyvu po startu kola. */
const centerTick = (speed: TimingSpeed, from: number): number => from + timingPeriod(TIMING.speed[speed]) / 2;

describe('načasování – generátor', () => {
  it('50 semínek × 3 rychlosti × 3 režimy splní invarianty hratelnosti', () => {
    for (const speed of TIMING_SPEEDS) {
      for (const mode of TIMING_MODES) {
        for (let seed = 1; seed <= 50; seed += 1) {
          expect(checkTimingLevel(timingLevel.generate(seed, params(speed, { mode }))), `${speed}/${mode}/${seed}`).toEqual([]);
        }
      }
    }
  });

  it('vyšší rychlost dá užší okno v ticích', () => {
    const [slow, normal, fast] = TIMING_SPEEDS.map((speed) => timingWindowTicks(TIMING.speed[speed], TIMING.tolerance));
    expect(slow).toBeGreaterThan(normal as number);
    expect(normal).toBeGreaterThan(fast as number);
    expect(fast).toBeGreaterThanOrEqual(3);
  });

  it('strana startu kol je ze semínka: stejné semínko = stejná úroveň, jiná semínka se liší', () => {
    expect(timingLevel.generate(7, params('normal'))).toEqual(timingLevel.generate(7, params('normal')));
    const sides = new Set(Array.from({ length: 10 }, (_, i) => JSON.stringify(timingLevel.generate(i + 1, params('normal')).bodies.map((b) => b.x))));
    expect(sides.size).toBeGreaterThan(1);
  });

  it('kontrola odhalí toleranci užší než krok a start mimo kraj', () => {
    expect(checkTimingLevel(timingLevel.generate(1, params('fast', { tolerance: 60 }))).join()).toMatch(/not wider than one tick of travel/);
    const level = timingLevel.generate(1, params('normal'));
    const moved: ArcadeLevel = { ...level, bodies: level.bodies.map((b, i) => (i === TIMING_SLOTS.marks + 1 ? { ...b, x: 100 } : b)) };
    expect(checkTimingLevel(moved).join()).toMatch(/round 2 does not start at the edge/);
  });
});

describe('načasování – ovládání a pravidla', () => {
  it('ťuk ve středu = trefa za 3 body, blok zůstane na věži a další kolo začne na kraji', () => {
    const level = timingLevel.generate(3, params('normal'));
    const w = worldOf(level, 'stack');
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    const at = centerTick('normal', 0);
    for (let tick = 0; tick < at; tick += 1) step(state, { buttons: 0, axis: 0 }, program);
    expect(state[bodyBase(TIMING_SLOTS.slider) + BODY.x]).toBe(0);
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(state[HEADER.counters + COUNTER.score]).toBe(3);
    const mark = bodyBase(TIMING_SLOTS.marks);
    expect((state[mark + BODY.flags] as number) & FLAG.alive).toBe(FLAG.alive);
    expect(state[mark + BODY.w]).toBe(TIMING.blockW);
    // Nové kolo: jezdec z kraje o jeden krok dál, o blok výš.
    const next = level.bodies[TIMING_SLOTS.marks + 1]!;
    expect(state[bodyBase(TIMING_SLOTS.slider) + BODY.x]).toBe(next.x + (next.vx ?? 0));
    expect(state[bodyBase(TIMING_SLOTS.slider) + BODY.y]).toBe(TIMING.baseH + TIMING.blockH);
    expect(state[bodyBase(0) + BODY.z]).toBe(1000);
  });

  it('stack usekne přečnívající část: další blok je o odchylku užší', () => {
    const level = timingLevel.generate(3, params('normal'));
    const w = worldOf(level, 'stack');
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    // Dva tiky před středem: odchylka 2 × 60 = 120, v toleranci 300.
    for (let tick = 0; tick < centerTick('normal', 0) - 2; tick += 1) step(state, { buttons: 0, axis: 0 }, program);
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(state[HEADER.counters + COUNTER.score]).toBe(2);
    expect(state[bodyBase(TIMING_SLOTS.marks) + BODY.w]).toBe(TIMING.blockW - 120);
    expect(state[bodyBase(TIMING_SLOTS.slider) + BODY.w]).toBe(TIMING.blockW - 120);
  });

  it('ťuk mimo toleranci = minutí: bez životů prohra, se životy život a totéž kolo znovu', () => {
    const level = timingLevel.generate(3, params('normal'));
    expect(replay(worldOf(level, 'precision'), [{ tick: 2, buttons: BUTTON.TAP, axis: 0 }], ARCADE_LIBRARY).outcome).toBe('lost');
    const w = worldOf(level, 'precision', 3);
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    step(state, { buttons: 0, axis: 0 }, program);
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(state[HEADER.counters + COUNTER.health]).toBe(2);
    expect(state[HEADER.runState]).toBe(0);
    expect(state[bodyBase(0) + BODY.z]).toBe(0);
    const first = level.bodies[TIMING_SLOTS.marks]!;
    expect(state[bodyBase(TIMING_SLOTS.slider) + BODY.x]).toBe(first.x + (first.vx ?? 0));
  });

  it('nečinný hráč prohraje po dvou kyvech (bez životů) i po ztrátě všech životů', () => {
    for (const speed of TIMING_SPEEDS) {
      const level = timingLevel.generate(5, params(speed));
      const lost = replay(worldOf(level, 'bridge'), [], ARCADE_LIBRARY);
      expect(lost.outcome, speed).toBe('lost');
      expect(lost.tick).toBe(2 * timingPeriod(TIMING.speed[speed]) + 1);
      expect(replay(worldOf(level, 'bridge', 3), [], ARCADE_LIBRARY).outcome, `${speed}/lives`).toBe('lost');
    }
  });

  it('všechna kola trefená = výhra v tiku poslední trefy', () => {
    const rounds = 4;
    const level = timingLevel.generate(9, params('fast', { rounds }));
    const period = timingPeriod(TIMING.speed.fast);
    // Nové kolo začne v tiku trefy (jezdec se v něm už posune), střed je tedy přesně o půl kyvu později.
    const taps: InputEvent[] = [];
    let at = period / 2;
    for (let round = 0; round < rounds; round += 1) {
      taps.push({ tick: at, buttons: BUTTON.TAP, axis: 0 });
      at += period / 2;
    }
    const run = replay(worldOf(level, 'stack'), taps, ARCADE_LIBRARY);
    expect(run.outcome).toBe('won');
    expect(run.tick).toBe((taps.at(-1)?.tick as number) + 1);
  });
});

// Spec načasování na šabloně poletování – kompilátor čte jen `control`, parametry a mechaniky.
const timingSpec = (controlParams: Record<string, unknown>, health?: number): GameSpecV1 => ({
  ...(flapFixture as GameSpecV1),
  control: 'timing',
  controlParams,
  mechanics: [...(flapFixture as GameSpecV1).mechanics, ...(health === undefined ? [] : [{ id: 'health' as const, params: { max: health } }])],
});

describe('načasování – robot a ověření', () => {
  it('robot vyhraje 30 semínek × 3 rychlosti, nečinný hráč prohraje, dvě přehrání dají týž hash', () => {
    for (const speed of TIMING_SPEEDS) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const mode = TIMING_MODES[seed % TIMING_MODES.length] as TimingMode;
        const made = arcadeWorldOf(timingSpec({ speed, mode }, seed % 2 === 0 ? 3 : undefined), seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        const verdict = verifyArcade(made.world);
        expect(verdict.failures, `${speed}/${seed}`).toEqual([]);
        expect(verdict.bot.outcome).toBe('won');
        expect(verdict.idle.outcome, `${speed}/${seed} idle`).toBe('lost');
        expect(verdict.replayEqual).toBe(true);
      }
    }
  });

  it('robot ťuká na střed: každá trefa za 3 body', () => {
    const made = arcadeWorldOf(timingSpec({ speed: 'fast', rounds: 10 }), 4);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const run = runBot(made.world);
    expect(run.outcome).toBe('won');
    expect(run.inputs).toHaveLength(10);
    const end = replayState(made.world, run.inputs);
    expect(end[HEADER.counters + COUNTER.score]).toBe(30);
  });

  it('úroveň s tolerancí užší než krok za tik kompilátor odmítne s důvodem', () => {
    const made = arcadeWorldOf(timingSpec({ speed: 'fast', tolerance: 60 }), 1);
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.issues.join()).toMatch(/tolerance 0\.06 m is not wider than one tick of travel \(0\.09 m\)/);
    const compiled = compileArcade(timingSpec({ speed: 'fast', tolerance: 60 }), 1);
    expect(compiled.ok ? null : compiled.reason).toBe('WORLD_REJECTED');
    // Spec takovou toleranci ani nepustí.
    expect(readGameSpec(timingSpec({ speed: 'fast', tolerance: 60 })).ok).toBe(false);
    expect(readGameSpec(timingSpec({ speed: 'fast', tolerance: TIMING.minSpecTolerance })).ok).toBe(true);
  });
});

function replayState(world: ArcadeWorld, inputs: readonly InputEvent[]): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let next = 0;
  for (let tick = 0; tick < 5400 && state[HEADER.runState] === 0; tick += 1) {
    const event = inputs[next];
    if (event !== undefined && event.tick === tick) next += 1;
    step(state, event !== undefined && event.tick === tick ? event : { buttons: 0, axis: 0 }, program);
  }
  return state;
}
