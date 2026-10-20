/**
 * Despawn fyzikálního tělesa (P54C T12r1): Rapier 0.19 po `setEnabled(false)` vyřadí ze simulace i těleso, které
 * se vypnutého dotýká – koule na zmizelé kouli zůstala viset ve vzduchu bez gravitace (sloupek dvou koulí v nádobě
 * slučování, 140 tiků), vzdálená spící koule se po cizím despawnu sama rozjela. Fáze proto zmizelé těleso
 * z Rapieru odebere; test čeká, že soused spadne na zem a vzdálená koule zůstane stát.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { BODY, type BodyInit, FLAG, NO_INPUT, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { releasePhysics } from '../physics/step';
import { loadRapier } from '../physics/world';
import { MERGE, MERGE_BODIES, QUEUE_LEVELS, mergeWorldOf, sizeOf } from '../pieces/merge-drop';

beforeAll(async () => {
  await loadRapier();
});

/** Předmět slučování úrovně `level` (koule Rapieru); různé úrovně se nesloučí. */
const ball = (level: number, x: number, y = 0): BodyInit => {
  const size = sizeOf(level);
  return { role: 'collectible', kind: 'item', x, y, z: 0, w: size, h: size, d: size, solid: false, physics: true, ball: true, restitution: MERGE.restitution };
};
const EXTRA = MERGE_BODIES.stones + QUEUE_LEVELS;

/** Nádoba slučování s tělesy `bodies`; v tiku `at` zmizí těleso `kill`; vrací [x, y] tělesa `watch` po každém tiku. */
function despawn(bodies: readonly BodyInit[], kill: number, watch: number, at = 60, ticks = 160): [number, number][] {
  const parts = mergeWorldOf([1], MERGE.lives);
  const built = buildWorld({ seed: 1, control: parts.control, rules: parts.rules, bot: parts.bot, level: { ...parts.level, bodies: [...parts.level.bodies, ...bodies] }, health: MERGE.lives }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const program = loadProgram(built.world, ARCADE_LIBRARY);
  const state = instantiate(built.world);
  const path: [number, number][] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    // Despawn jako efekt jádra: jen shozený příznak `alive`.
    if (tick === at) state[bodyBase(EXTRA + kill) + BODY.flags] = (state[bodyBase(EXTRA + kill) + BODY.flags] as number) & ~FLAG.alive;
    step(state, NO_INPUT, program);
    path.push([state[bodyBase(EXTRA + watch) + BODY.x] as number, state[bodyBase(EXTRA + watch) + BODY.y] as number]);
  }
  releasePhysics(state);
  return path;
}

describe('a despawned physics body leaves its neighbours to the physics (P54C T12r1)', () => {
  it('a ball resting on a ball that disappears falls to the ground', () => {
    const path = despawn([ball(2, 0), ball(1, 0, sizeOf(2) + 50)], 0, 1);
    const [, restingY] = path[59]!;
    expect(restingY).toBeGreaterThan(sizeOf(2) / 2);
    // Do 40 tiků po despawnu leží na zemi (spodek AABB u nuly), ne ve výšce, kde ležel na sousedovi.
    expect(Math.abs(path[100]![1])).toBeLessThanOrEqual(15);
  });

  it('a resting ball far away does not start to roll when another ball disappears', () => {
    const path = despawn([ball(1, -3000), ball(2, 3000)], 0, 1);
    expect(Math.abs(path[159]![0] - path[59]![0])).toBeLessThanOrEqual(5);
  });
});
