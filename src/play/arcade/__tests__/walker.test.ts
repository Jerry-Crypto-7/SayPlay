import { describe, expect, it } from 'vitest';
import { canonicalHash } from '@/ir/worlddoc';
import { BODY, BUTTON, COUNTER, HEADER, NO_INPUT, bodyBase, type ModeGeneratorPiece } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, step, type ArcadeLibrary } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { walkerCaught, walkerControl, walkerEscape, walkerLabyrinth, walkerMaze, walkerParamsSchema, walkerPath, walkerStealth, walkerVelocity, walkerVisible, type WalkerParams } from '../pieces/walker';
import { walkerBot } from '../pieces/walker-bot';
import { verifyArcade } from '../verify';
import type { RoleBinding } from '../witness';

// Native seam until the root registers walker after the GameSpec widening.
const library: ArcadeLibrary = {
  ...ARCADE_LIBRARY,
  controls: { ...ARCADE_LIBRARY.controls, walker: walkerControl },
  rules: { ...ARCADE_LIBRARY.rules, walker_caught: walkerCaught },
  bots: { ...ARCADE_LIBRARY.bots, walker_bot: walkerBot },
};
const modes = [walkerLabyrinth, walkerStealth, walkerEscape];
function made(generator: ModeGeneratorPiece<WalkerParams>, seed: number, collect = false) {
  const params = walkerParamsSchema.parse(collect ? { collect: true } : {});
  const parts = generator.parts(seed, params, undefined);
  expect(parts.issues).toEqual([]);
  const built = buildWorld({ seed, ...parts }, library);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const roleBindings: RoleBinding[] = parts.level.bodies.flatMap((body, index) => body.kind === 'wall' ? [] : [{
    body: index, roleId: body.kind === 'wall' ? `wall${index}` : body.kind, label: body.kind,
    roleKind: body.role === 'player' ? 'player' : body.role === 'goal' ? 'exit' : body.role === 'chaser' ? 'chaser' : body.role === 'enemy' ? 'patrol' : body.role === 'collectible' ? 'collectible' : 'hazard', player: index === 0,
  }]);
  return { world: built.world, parts, roleBindings };
}

describe('native walker', () => {
  it.each(Array.from({ length: 20 }, (_, i) => i + 1))('collects a real item on the route before exiting, seed %s', seed => {
    const first = made(walkerStealth, seed, true);
    const verdict = verifyArcade(first.world, library, first.roleBindings);
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.replayEqual).toBe(true);
    expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'collect', evidence: 'pickup', object: expect.objectContaining({ roleId: 'coin' }) }));
  });
  it.each(modes.flatMap(generator => Array.from({ length: 20 }, (_, index) => ({ generator, id: generator.id, seed: index + 1 }))))('$id seed $seed is reachable, playable and deterministic', ({ generator, seed }) => {
    const first = made(generator, seed);
    expect(canonicalHash(first.world)).toBe(canonicalHash(made(generator, seed).world));
    const map = walkerMaze(seed, 11);
    const path = walkerPath(map, 12, 108);
    expect(path.length).toBeGreaterThan(2);
    expect(path.every(cell => map.open.includes(cell))).toBe(true);
    const verdict = verifyArcade(first.world, library, first.roleBindings);
    expect(verdict.failures).toEqual([]);
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.idle.outcome).toBe('lost');
    expect(verdict.replayEqual).toBe(true);
    expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'reach', evidence: 'finish-contact', run: 'winner' }));
    if (generator === walkerEscape) {
      expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'chaser', run: 'probe' }));
      expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'escape', run: 'winner' }));
    }
  });

  it('uses all eight directions without a faster diagonal or stationary alias', () => {
    const directions = [
      { axis: 1000, buttons: 0 }, { axis: -1000, buttons: 0 },
      { axis: 0, buttons: BUTTON.UP }, { axis: 0, buttons: BUTTON.DOWN },
      ...[1000, -1000].flatMap(axis => [BUTTON.UP, BUTTON.DOWN].map(buttons => ({ axis, buttons }))),
    ].map(input => walkerVelocity(input, 110));
    expect(new Set(directions.map(direction => JSON.stringify(direction))).size).toBe(8);
    expect(directions.every(({ vx, vz }) => vx * vx + vz * vz <= 110 * 110 && vx * vx + vz * vz > 100 * 100)).toBe(true);
  });

  it('a blocked maze has no claimed route', () => {
    const map = walkerMaze(1, 11);
    expect(walkerPath({ ...map, open: map.open.filter(cell => cell !== 108) }, 12, 108)).toEqual([]);
  });

  it('the patrolling guard really catches an idle player and takes lives', () => {
    const { world, parts } = made(walkerStealth, 1);
    const state = instantiate(world), program = loadProgram(world, library);
    const guard = parts.level.bodies.length - 1;
    const start = state[bodyBase(guard) + BODY.z]!;
    let moved = false, caught = false;
    for (let tick = 0; tick < 1200 && outcomeOf(state) === 'running'; tick++) {
      step(state, NO_INPUT, program);
      moved ||= state[bodyBase(guard) + BODY.z] !== start;
      caught ||= state[HEADER.counters + COUNTER.health]! < 3;
    }
    expect(moved).toBe(true);
    expect(caught).toBe(true);
    expect(outcomeOf(state)).toBe('lost');
  });

  it('the guard cone rejects a player behind it and walls occlude sight', () => {
    const { world, parts } = made(walkerStealth, 1);
    const state = instantiate(world), guard = parts.level.bodies.length - 1;
    const p = bodyBase(0), g = bodyBase(guard), map = walkerMaze(1, 11);
    state[g + BODY.x] = 4000; state[g + BODY.z] = 0; state[g + BODY.vz] = 40;
    state[p + BODY.x] = 4000; state[p + BODY.z] = 4000;
    expect(walkerVisible(state, 0, guard, map, 5000)).toBe(true);
    state[g + BODY.vz] = -40;
    expect(walkerVisible(state, 0, guard, map, 5000)).toBe(false);
    state[g + BODY.vz] = 40;
    expect(walkerVisible(state, 0, guard, { ...map, open: map.open.filter(cell => cell !== 1) }, 5000)).toBe(false);
  });
});
