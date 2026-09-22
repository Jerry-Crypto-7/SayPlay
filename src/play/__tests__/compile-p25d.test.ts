/**
 * Pravidla P25D – dotažení mřížkových her. Každé pravidlo má fixturu,
 * svědka, který vyhraje, keypoint a test, že svět bez pravidla se chová jinak
 * (jinak by keypoint mohl projít i proto, že pravidlo nic nedělá).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { type Runtime, createRuntime, entityActive, step } from '@/sim/interpreter';
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

describe('hazard_zone.pulse.alternate – moving walls (P25D T3)', () => {
  const gameSpec = fixture('collect_exit_moving_walls');

  it('compiles, certifies a witness and passes every keypoint on seeds 1..5', () => {
    for (const seed of [1, 2, 3, 4, 5]) expect(publishFailures(gameSpec, seed), `seed ${seed}`).toEqual([]);
  });

  it('each wall stands in exactly one of its two positions and shifts every 2 s; without the stagger both stand at once', () => {
    const states = (sim: SurfaceSim, ticks: number): string[] => {
      const runtime = runtimeOf(sim);
      const seen: string[] = [];
      for (let tick = 0; tick < ticks; tick += 1) {
        step(runtime, []);
        const row = ['wall_1', 'wall_2', 'wall_3', 'wall_4'].map((id) => runtime.entityStates.get(id)?.values[readSlot(runtime.layout, runtime.state, `e:${id}:state`)]);
        seen.push(row.join(','));
      }
      return seen;
    };
    const { sim } = compiled(gameSpec, 1);
    expect(Object.keys(sim.entities).filter((id) => id.startsWith('wall'))).toEqual(['wall_1', 'wall_2', 'wall_3', 'wall_4']);
    const walls = states(sim, 170);
    expect(new Set(walls)).toEqual(new Set(['on,off,on,off', 'off,on,off,on']));
    expect(walls.indexOf('off,on,off,on')).toBeGreaterThan(30);
    expect(walls.lastIndexOf('on,off,on,off')).toBeGreaterThan(100);
    expect(states(without(sim, /\.stagger$/), 5)[2]).toBe('on,on,on,on');
  });

  it('drafts s076 with moving walls, and the drafted game publishes', () => {
    const drafted = draftGameSpec('a maze game where the walls move');
    expect(drafted.mechanics.find((mechanic) => mechanic.id === 'hazard_zone')?.params.pulse).toMatchObject({ alternate: true });
    expect(drafted.verification.map((assertion) => assertion.id)).toContain('standing_wall_loses');
    expect(publishFailures(drafted, 1)).toEqual([]);
  });
});

describe('smash and pop – defeat without enemies (P25D T4)', () => {
  it('drafts s097 and s198 as destroy-everything games where the last smash wins, and each publishes', () => {
    for (const [sentence, label] of [
      ['destroy everything in a house with a hammer, smash simulator', 'vase'],
      ['satisfying game where you pop stuff', 'bubble'],
    ] as const) {
      const drafted = draftGameSpec(sentence);
      expect(drafted.archetype, sentence).toBe('combat_lite');
      expect(drafted.roles.find((role) => role.id === 'slime')?.label, sentence).toBe(label);
      expect(drafted.mechanics.map((mechanic) => mechanic.id), sentence).toEqual(['defeat']);
      const last = drafted.verification.find((assertion) => assertion.id === 'hit_removes_slime');
      expect(last?.assert, sentence).toMatchObject({ runState: 'won' });
      expect(publishFailures(drafted, 1), sentence).toEqual([]);
    }
  });
});

describe('treating patients – orders renamed (P25D T5)', () => {
  it('drafts s169 as a vet clinic where the right treatment scores and the wrong one does not, and it publishes', () => {
    const drafted = draftGameSpec('a vet clinic where you heal cute pets');
    expect(drafted.archetype).toBe('delivery');
    expect(drafted.roles.map((role) => role.label)).toEqual(['vet', 'medicine', 'bandage', 'sick pet']);
    expect(drafted.mechanics.find((mechanic) => mechanic.id === 'carry')?.params.menu).toEqual(['burger', 'fries']);
    expect(drafted.verification.map((assertion) => assertion.id)).toEqual(['right_order_scores', 'wrong_order_ignored', 'winnable']);
    expect(publishFailures(drafted, 1)).toEqual([]);
  });
});

describe('collectible.hiddenIn – search the room (P25D T2)', () => {
  const gameSpec = fixture('collect_exit_hidden');

  it('compiles, certifies a witness that searches every spot and passes every keypoint on seeds 1..5', () => {
    for (const seed of [1, 2, 3, 4, 5]) expect(publishFailures(gameSpec, seed), `seed ${seed}`).toEqual([]);
  });

  it('a hidden item neither shows nor counts until the player enters its spot; without hiddenIn it counts at once', () => {
    const { sim } = compiled(gameSpec, 1);
    const item = Object.keys(sim.entities).find((id) => id.startsWith('mushroom')) as string;
    const spot = Object.keys(sim.entities).find((id) => id.startsWith('spot')) as string;
    const pickup = [{ tick: 2, actionId: 'pickup', target: item }];
    const collected = (runtime: Runtime): number => readSlot(runtime.layout, runtime.state, 'c:collected');

    const hidden = runtimeOf(sim);
    run(hidden, pickup, 6);
    expect(collected(hidden)).toBe(0);
    expect(entityActive(hidden, item)).toBe(false);

    const found = runtimeOf(sim);
    run(found, [{ tick: 0, actionId: 'moveTo', target: spot }, { tick: 40, actionId: 'pickup', target: item }], 44);
    expect(entityActive(found, item)).toBe(true);
    expect(collected(found)).toBe(1);

    const { hiddenIn: _dropped, ...openParams } = gameSpec.mechanics[0]?.params as Record<string, unknown>;
    const openSpec = { ...gameSpec, mechanics: gameSpec.mechanics.map((mechanic, index) => (index === 0 ? { ...mechanic, params: openParams } : mechanic)) };
    const open = runtimeOf(compiled(openSpec, 1).sim);
    run(open, pickup, 6);
    expect(collected(open)).toBe(1);
  });

  it('drafts s074 and s184 as a search game with spots, and each drafted game publishes', () => {
    for (const sentence of [
      'find the hidden objects in a messy bedroom',
      'explore underwater ruins as a little submarine',
    ]) {
      const drafted = draftGameSpec(sentence);
      expect(drafted.archetype, sentence).toBe('collect_exit');
      expect(drafted.mechanics.find((mechanic) => mechanic.id === 'collectible')?.params.hiddenIn, sentence).toBe('spot');
      expect(drafted.verification.map((assertion) => assertion.id), sentence).toContain('hidden_item_does_not_count');
      expect(publishFailures(drafted, 1), sentence).toEqual([]);
    }
    const sea = draftGameSpec('explore underwater ruins as a little submarine');
    expect([sea.roles.find((role) => role.id === 'mushroom')?.label, sea.roles.find((role) => role.id === 'portal')?.label]).toEqual(['relic', 'surface']);
  });
});
