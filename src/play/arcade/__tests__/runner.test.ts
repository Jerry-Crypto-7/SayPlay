import { describe, expect, it } from 'vitest';

import { BODY, BUTTON, NO_INPUT, bodyBase } from '../contract';
import { type ArcadeLibrary, buildWorld, instantiate, loadProgram, step } from '../kernel';
import { RULES } from '../pieces/rules';
import { JUMP_PEAK, OBSTACLES, RUNNER, RUNNER_DENSITIES, RUNNER_TRACK, checkRunnerLevel, runnerControl, runnerTrack } from '../pieces/runner';

const params = (density: (typeof RUNNER_DENSITIES)[number], extra: Record<string, unknown> = {}) => runnerTrack.params.parse({ density, ...extra });
const obstacles = (seed: number, density: (typeof RUNNER_DENSITIES)[number]) =>
  runnerTrack.generate(seed, params(density)).bodies.filter((body) => body.role === 'obstacle').length;

describe('běžec – rozměry drží „hratelné z konstrukce“', () => {
  it('překážka ke skoku je pod vrcholem skoku, překážky na pruh nad ním', () => {
    expect(OBSTACLES.hurdle.h).toBeLessThan(JUMP_PEAK - 300);
    expect(OBSTACLES.cone.y + OBSTACLES.cone.h).toBeGreaterThan(JUMP_PEAK);
    expect(OBSTACLES.crate.y + OBSTACLES.crate.h).toBeGreaterThan(JUMP_PEAK);
  });

  it('pod tyčí se projde jen skluzem', () => {
    expect(RUNNER.slideH).toBeLessThan(OBSTACLES['slide-bar'].y);
    expect(RUNNER.runH).toBeGreaterThan(OBSTACLES['slide-bar'].y);
  });
});

describe('běžec – generátor', () => {
  it('50 semínek × 3 hustoty splní invarianty hratelnosti', () => {
    for (const density of RUNNER_DENSITIES) {
      for (let seed = 1; seed <= 50; seed += 1) {
        for (const speed of ['slow', 'fast'] as const) {
          const level = runnerTrack.generate(seed * 7919, params(density, { speed, lengthM: RUNNER_TRACK.maxLengthM }));
          expect(checkRunnerLevel(level, speed), `${density}/${speed}/${seed}`).toEqual([]);
        }
        expect(checkRunnerLevel(runnerTrack.generate(seed, params(density)), 'normal')).toEqual([]);
      }
    }
  });

  it('bez přeskočitelných druhů řada nezavře všechny tři pruhy', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const level = runnerTrack.generate(seed, params('high', { obstacles: ['crate', 'cone'] }));
      expect(checkRunnerLevel(level, 'normal')).toEqual([]);
    }
  });

  it('„high“ má víc překážek než „low“ na každém semínku', () => {
    for (let seed = 1; seed <= 50; seed += 1) expect(obstacles(seed, 'high')).toBeGreaterThan(obstacles(seed, 'low'));
  });

  it('stejné semínko = stejná trať, jiné semínko = jiná', () => {
    expect(runnerTrack.generate(42, params('normal'))).toEqual(runnerTrack.generate(42, params('normal')));
    expect(runnerTrack.generate(42, params('normal'))).not.toEqual(runnerTrack.generate(43, params('normal')));
  });

  it('kontrola odhalí zavřenou řadu a příliš blízké řady', () => {
    const crate = (x: number, z: number) => ({ role: 'obstacle' as const, kind: 'crate', x, y: 0, z, w: 1400, h: 1500, d: 1400, solid: true });
    const level = {
      bodies: [runnerTrack.generate(1, params('low')).bodies[0]!, crate(-2000, 40_000), crate(0, 40_000), crate(2000, 40_000), crate(0, 41_000)],
      length: 100_000,
    };
    const issues = checkRunnerLevel(level, 'normal');
    expect(issues.join('\n')).toMatch(/blocks all 3 lanes/);
    expect(issues.join('\n')).toMatch(/closer than/);
    expect(issues.join('\n')).toMatch(/no finish line/);
  });
});

describe('běžec – ovládání', () => {
  const library: ArcadeLibrary = { controls: { runner: runnerControl }, rules: RULES, generators: {}, bots: {} };
  const setup = () => {
    const level = { bodies: [runnerTrack.generate(1, params('low')).bodies[0]!], length: 0 };
    const built = buildWorld({ seed: 1, control: { id: 'runner', params: {} }, rules: [], bot: { id: 'none', params: {} }, level }, { ...library, bots: { none: { id: 'none', params: runnerControl.params, roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT } } });
    if (!built.ok) throw new Error(built.issues.join());
    return { state: instantiate(built.world), program: loadProgram(built.world, library) };
  };
  const at = (slot: keyof typeof BODY) => bodyBase(0) + BODY[slot];

  it('běží sám vpřed', () => {
    const { state, program } = setup();
    for (let t = 0; t < 60; t += 1) step(state, NO_INPUT, program);
    expect(state[at('z')]).toBe(60 * 150);
  });

  it('vlevo přesune do sousedního pruhu a dál už ne', () => {
    const { state, program } = setup();
    step(state, { buttons: BUTTON.LEFT, axis: 0 }, program);
    for (let t = 0; t < 10; t += 1) step(state, NO_INPUT, program);
    expect(state[at('x')]).toBe(-RUNNER.laneWidth);
    step(state, { buttons: BUTTON.LEFT, axis: 0 }, program);
    for (let t = 0; t < 10; t += 1) step(state, NO_INPUT, program);
    expect(state[at('x')]).toBe(-RUNNER.laneWidth);
  });

  it('ťuk skočí jen ze země', () => {
    const { state, program } = setup();
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(state[at('y')]).toBeGreaterThan(0);
    const vy = state[at('vy')] as number;
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(state[at('vy')]).toBeLessThan(vy);
  });

  it('dolů sníží obrys na dobu skluzu', () => {
    const { state, program } = setup();
    step(state, { buttons: BUTTON.DOWN, axis: 0 }, program);
    expect(state[at('h')]).toBe(RUNNER.slideH);
    for (let t = 0; t < RUNNER.slideTicks; t += 1) step(state, NO_INPUT, program);
    expect(state[at('h')]).toBe(RUNNER.runH);
  });
});
