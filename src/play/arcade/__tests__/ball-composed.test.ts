import { beforeAll, describe, expect, it } from 'vitest';
import { draftGameSpecWithMeta } from '@/play/draft';
import { arcadeWorldOf } from '../compile';
import { BODY, BUTTON, COUNTER, FLAG, HEADER, bodyBase, type ArcadeWorld } from '../contract';
import { buildWorld, instantiate, loadProgram } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { releasePhysics } from '../physics/step';
import { loadRapier } from '../physics/world';
import { BALL, ballLaunch, ballPitch, ballScore } from '../pieces/ball';

// P42 nálezy 9–10: soupeřův míč, který se na hřišti zastaví, nesmí držet hru
// do timeoutu; spawn týmu nesmí spolknout hráčovu ránu; DOWN ve složené hře
// dribluje a nesmí nulovat nabíjení.
beforeAll(loadRapier);

const teamWorld = (): ArcadeWorld => {
  const params = ballPitch.params.parse({ team: true, goal: 'goal' });
  const made = buildWorld({ seed: 1, ...ballPitch.parts(1, params, undefined) }, ARCADE_LIBRARY);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
const ruleParams = <P,>(world: ArcadeWorld, id: string): P => world.rules.find((rule) => rule.id === id)!.params as P;
const kindOf = (world: ArcadeWorld, kind: string) => world.kinds.indexOf(kind);
const bodyOfKind = (world: ArcadeWorld, state: Int32Array, kind: string): number =>
  Array.from({ length: state[HEADER.bodyCount]! }, (_, i) => i).find((i) => state[bodyBase(i) + BODY.kind] === kindOf(world, kind))!;

describe('composed ball games end cleanly and keep player shots', () => {
  it('(a) an opponent ball at rest on the pitch is cleared, so an empty quiver loses before the timeout', () => {
    const world = teamWorld(), state = instantiate(world);
    const params = ballScore.params.parse(ruleParams(world, 'ball_score'));
    try {
      // Soupeřův míč leží v klidu na hřišti: mimo branku, z ≥ -2000.
      const ball = bodyOfKind(world, state, 'opponent-ball'), b = bodyBase(ball);
      state[b + BODY.flags] = state[b + BODY.flags]! | FLAG.alive | FLAG.physics | FLAG.ball;
      state[b + BODY.x] = -6000; state[b + BODY.y] = 0; state[b + BODY.z] = 6000;
      state[b + BODY.vx] = 0; state[b + BODY.vy] = 0; state[b + BODY.vz] = 0;
      state[HEADER.counters + COUNTER.ammo] = 0;
      state[HEADER.tick] = 900;
      expect(state[HEADER.tick]).toBeLessThan(params.timeout);
      const player = state[HEADER.player]!;
      expect(ballScore.fire({ state, player } as never, params)).toEqual([{ kind: 'despawn', body: ball }]);
      state[b + BODY.flags] = state[b + BODY.flags]! & ~FLAG.alive;
      expect(ballScore.fire({ state, player } as never, params)).toEqual([{ kind: 'lose' }]);

      // Míč v pohybu na hřišti zůstává ve hře.
      state[b + BODY.flags] = state[b + BODY.flags]! | FLAG.alive;
      state[b + BODY.vz] = -200;
      expect(ballScore.fire({ state, player } as never, params)).toEqual([]);
      // Míč, který odkutálel z hřiště na stranu soupeře, zmizí jako hráčův.
      state[b + BODY.z] = 31000;
      expect(ballScore.fire({ state, player } as never, params)).toEqual([{ kind: 'despawn', body: ball }]);
    } finally { releasePhysics(state); }
  });

  it('(b) a released shot on the kickoff tick launches alongside the opposing ball', () => {
    const world = teamWorld(), state = instantiate(world);
    const params = ballLaunch.params.parse(ruleParams(world, 'ball_launch'));
    try {
      const player = state[HEADER.player]!;
      state[HEADER.tick] = 241;
      expect(state[HEADER.tick]! % 240).toBe(1);
      state[HEADER.counters + COUNTER.cooldown] = 0;
      state[bodyBase(player) + BODY.aux1] = -30;
      const effects = ballLaunch.fire({ state, player } as never, params);
      const spawns = effects.filter((effect) => effect.kind === 'spawn').map((effect) => (effect as { template: number }).template);
      expect(spawns.sort()).toEqual([params.template, params.team!.template].sort());
      expect(effects).toContainEqual({ kind: 'count', counter: 'ammo', amount: -1 });
    } finally { releasePhysics(state); }
  });

  it('(c) DOWN dribbles back in a composed pitch without resetting the charge', () => {
    const { spec } = draftGameSpecWithMeta('kick the ball into the net, a dog chases you', 1);
    expect(spec.control).toBe('ball');
    expect(spec.assemblyParts?.length ?? 0).toBeGreaterThan(0);
    const made = arcadeWorldOf({ ...spec, scoring: spec.scoring ?? {} }, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const world = made.world, program = loadProgram(world, ARCADE_LIBRARY), state = instantiate(world);
    expect(world.control.id).toBe('assembly_control');
    try {
      const player = state[HEADER.player]!, p = bodyBase(player);
      for (let tick = 0; tick < 10; tick++) program.control.piece.step(state, player, { buttons: BUTTON.HOLD | BUTTON.DOWN, axis: 0 }, program.control.params);
      expect(state[p + BODY.aux1]).toBe(10);
      expect(state[p + BODY.vz]).toBeLessThan(0);
      expect(BALL.maxCharge).toBeGreaterThan(10);
    } finally { releasePhysics(state); }
  });
});
