/**
 * Pravidla P25D – dotažení mřížkových her. Každé pravidlo má fixturu,
 * svědka, který vyhraje, keypoint a test, že svět bez pravidla se chová jinak
 * (jinak by keypoint mohl projít i proto, že pravidlo nic nedělá).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { type Runtime, createRuntime, step } from '@/sim/interpreter';
import { readSlot, writeSlot } from '@/sim/state';

import { compileGame, compileSim, greenStart, type SimCompilation, type SurfaceSim } from '../compile';
import { draftGameSpec } from '../draft';
import { verifyGame } from '../verify';
import { readGameSpec, type GameSpecV1 } from '../spec';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

function fixture(name: string): GameSpecV1 {
  const result = readGameSpec(JSON.parse(readFileSync(`${fixturesDir}p25d/${name}.json`, 'utf8')));
  if (!result.ok) throw new Error(`${name}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

function compiled(spec: GameSpecV1, seed: number): SimCompilation {
  const result = compileSim(spec, seed);
  if (!result.ok) throw new Error(`${spec.title}/${seed}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

function runtimeOf(sim: SurfaceSim): Runtime {
  const built = buildRuntimeWorld(sim);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return createRuntime(built.world);
}

function run(runtime: Runtime, inputs: readonly { tick: number; actionId: string; target: string }[], ticks: number): string {
  for (let tick = 0; tick < ticks && runtime.runState === 'running'; tick += 1) {
    step(runtime, inputs.filter((input) => input.tick === tick).map((input) => ({ ...input, actor: 'player' })));
  }
  return runtime.runState;
}

/** Zkompiluje, ověří a vrátí keypointy, které neprošly (prázdné = hra se smí publikovat). */
function publishFailures(spec: GameSpecV1, seed: number): string[] {
  const result = compileGame(spec, seed);
  if (!result.ok) return [`${result.reason}: ${result.issues.join('; ')}`];
  const report = verifyGame(result.value);
  const failed = report.keypoints.filter((keypoint) => !keypoint.passed).map((keypoint) => `${keypoint.assertionId}: ${keypoint.failures.join('; ')}`);
  return report.publishEligible ? failed : [...failed, 'not publish eligible'];
}

const without = (sim: SurfaceSim, pattern: RegExp): SurfaceSim => ({
  ...sim,
  rules: Object.fromEntries(Object.entries(sim.rules).filter(([id]) => !pattern.test(id))),
});

describe('timer.phases – red light, green light (P25D T1)', () => {
  const gameSpec = fixture('collect_exit_red_light');

  it('compiles, certifies a witness that walks only on green and passes every keypoint on seeds 1..5', () => {
    for (const seed of [1, 2, 3, 4, 5]) expect(publishFailures(gameSpec, seed), `seed ${seed}`).toEqual([]);
  });

  it('a step on red loses, standing on red does not, and without the phase rules the step survives', () => {
    const { sim } = compiled(gameSpec, 1);
    const toPortal = [{ tick: 0, actionId: 'moveTo', target: 'portal' }];
    const redNow = (world: SurfaceSim): Runtime => {
      const runtime = runtimeOf(world);
      writeSlot(runtime.layout, runtime.state, 'f:light_red', 1);
      return runtime;
    };
    expect(run(redNow(sim), toPortal, 6)).toBe('lost');
    expect(run(redNow(sim), [], 40)).toBe('running');
    expect(run(redNow(without(sim, /^timer\.light\.moved\./)), toPortal, 6)).toBe('running');
  });

  it('schedules each witness walk wholly inside green, and a walk that runs into red loses', () => {
    const window = { goTicks: 40, stopTicks: 40 };
    expect(greenStart(5, 10, window)).toBe(5);
    // Chůze by doběhla do červené → další zelená plus rezerva; v červené totéž.
    expect(greenStart(30, 10, window)).toBe(83);
    expect(greenStart(50, 10, window)).toBe(83);
    expect(greenStart(0, 10, window)).toBe(3);
    // Chůze delší než zelená se neposouvá: svědek prohraje a hra se nepublikuje.
    expect(greenStart(30, 38, window)).toBe(30);

    const { sim } = compiled(gameSpec, 1);
    // Zelená fixtury je 40 tiků: chůze k cíli odstartovaná v 35. tiku doběhne do červené.
    expect(run(runtimeOf(sim), [{ tick: 35, actionId: 'moveTo', target: 'portal' }], 80)).toBe('lost');
    expect(run(runtimeOf(sim), [{ tick: greenStart(35, 20, { goTicks: 40, stopTicks: 40 }), actionId: 'moveTo', target: 'portal' }], 160)).toBe('running');
  });

  it('switches the light by ticks: green for goSeconds, red for stopSeconds, the doll watching on red', () => {
    const { sim } = compiled(gameSpec, 1);
    const runtime = runtimeOf(sim);
    const red: number[] = [];
    const watching: number[] = [];
    for (let tick = 0; tick < 250; tick += 1) {
      step(runtime, []);
      if (readSlot(runtime.layout, runtime.state, 'f:light_red') === 1) red.push(runtime.tick);
      const doll = runtime.entityStates.get('watcher');
      if (doll?.values[readSlot(runtime.layout, runtime.state, 'e:watcher:state')] === 'watching') watching.push(runtime.tick);
    }
    expect([red[0], red.length]).toEqual([41, 120]);
    expect(watching).toEqual(red);
  });

  it('drafts s153, s176 and s178 with the light, and each drafted game publishes', () => {
    for (const sentence of [
      'red light green light like squid game',
      'five nights at freddys but in a school',
      'horror game where a creepy doll moves when u dont look',
    ]) {
      const drafted = draftGameSpec(sentence);
      expect(drafted.archetype, sentence).toBe('collect_exit');
      expect(drafted.mechanics.find((mechanic) => mechanic.id === 'timer')?.params.phases, sentence).toBeDefined();
      expect(drafted.verification.map((assertion) => assertion.id), sentence).toContain('moving_on_red_loses');
      expect(publishFailures(drafted, 1), sentence).toEqual([]);
    }
    expect(draftGameSpec('horror game where a creepy doll moves when u dont look').roles.find((role) => role.id === 'watcher')?.label).toBe('creepy doll');
    expect(draftGameSpec('red light green light like squid game').roles.find((role) => role.id === 'portal')?.label).toBe('finish line');
  });
});
