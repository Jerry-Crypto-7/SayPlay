import { beforeAll, describe, expect, it } from 'vitest';
import { BODY, BUTTON, COUNTER, FLAG, HEADER, NO_INPUT, bodyBase, type ArcadeWorld } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step, type ArcadeLibrary } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { releasePhysics } from '../physics/step';
import { loadRapier } from '../physics/world';
import { BALL_GOALS, ballControl, ballLaunch, ballPitch, ballScore, type BallPitchParams } from '../pieces/ball';
import { ballBot, solveBall } from '../pieces/ball-bot';
import { runBot } from '../verify';

const library: ArcadeLibrary = { controls: { ...ARCADE_LIBRARY.controls, ball: ballControl }, rules: { ...ARCADE_LIBRARY.rules, ball_launch: ballLaunch, ball_score: ballScore }, bots: { ...ARCADE_LIBRARY.bots, ball_bot: ballBot }, generators: { ...ARCADE_LIBRARY.generators, ball_pitch: ballPitch } };
function worldOf(seed: number, extra: Partial<BallPitchParams> = {}): ArcadeWorld {
  const params = ballPitch.params.parse(extra);
  const built = buildWorld({ seed, ...ballPitch.parts(seed, params, undefined) }, library);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}
beforeAll(async () => { await loadRapier(); });

describe('native physics ball', () => {
  it.each(BALL_GOALS)('%s is reached by real shots for seeds 1–20, with and without keeper', goal => {
    for (let seed = 1; seed <= 20; seed++) for (const keeper of [false, true]) {
      const world = worldOf(seed, { goal, keeper });
      expect(worldOf(seed, { goal, keeper })).toEqual(world);
      const bot = runBot(world, library, { planner: false });
      expect(bot.outcome, `${goal}/${seed}/${keeper}`).toBe('won');
      expect(bot.inputs.some(input => input.buttons & BUTTON.HOLD)).toBe(true);
      expect(bot.inputs.some(input => input.buttons & BUTTON.TAP)).toBe(true);
      const again = replay(world, bot.inputs, library);
      expect(again.hash).toBe(bot.hash);
      expect(again.tick).toBe(bot.tick);
    }
  }, 120_000);

  it.each(BALL_GOALS)('%s idle loses without gaining score', goal => {
    const result = replay(worldOf(1, { goal }), [], library);
    expect(result.outcome).toBe('lost');
  });

  it.each(BALL_GOALS)('%s supports five targets at maximum difficulty', goal => {
    for (let seed = 1; seed <= 5; seed++) expect(runBot(worldOf(seed, { goal, keeper: true, targets: 5, difficulty: 'hard' }), library, { planner: false }).outcome).toBe('won');
  }, 120_000);

  it('the launched body is a dynamic Rapier sphere, not a kernel projectile', () => {
    const world = worldOf(3), state = instantiate(world), program = loadProgram(world, library);
    try {
      for (let i = 0; i < 30; i++) step(state, { axis: 400, buttons: BUTTON.HOLD }, program);
      step(state, { axis: 400, buttons: BUTTON.TAP }, program);
      const spawned = state[HEADER.spawnBase]!;
      const b = bodyBase(spawned), flags = state[b + BODY.flags]!;
      expect(flags & FLAG.physics).not.toBe(0); expect(flags & FLAG.ball).not.toBe(0);
      const before = { x: state[b + BODY.x]!, y: state[b + BODY.y]!, z: state[b + BODY.z]!, vy: state[b + BODY.vy]! };
      step(state, NO_INPUT, program);
      expect(state[b + BODY.x]).toBeGreaterThan(before.x); expect(state[b + BODY.z]).toBeGreaterThan(before.z);
      expect(state[b + BODY.vy]).toBeLessThan(before.vy);
    } finally { releasePhysics(state); }
  });

  it('missing the actual target never becomes a timed score', () => {
    const world = worldOf(5), state = instantiate(world), program = loadProgram(world, library);
    try {
      for (let i = 0; i < 60; i++) step(state, { axis: -1000, buttons: BUTTON.HOLD }, program);
      step(state, { axis: -1000, buttons: BUTTON.TAP }, program);
      for (let i = 0; i < 300; i++) step(state, NO_INPUT, program);
      expect(state[HEADER.counters + COUNTER.score]).toBe(0);
      expect(outcomeOf(state)).not.toBe('won');
    } finally { releasePhysics(state); }
  });

  it('generated target volumes have an analytic launch solution', () => {
    for (const goal of BALL_GOALS) for (let seed = 1; seed <= 20; seed++) {
      const level = ballPitch.generate(seed, ballPitch.params.parse({ goal, targets: 5, difficulty: 'hard' }));
      for (const target of level.bodies.filter(body => body.role === 'target')) expect(solveBall(target, goal), `${goal}/${seed}`).not.toBeNull();
    }
  });
});


it('cancel input resets native charge without launching a ball', () => {
 const world=worldOf(1), state=instantiate(world), program=loadProgram(world,library);
 try {
   for(let tick=0;tick<20;tick++) step(state,{axis:200,buttons:BUTTON.HOLD},program);
   step(state,{axis:0,buttons:BUTTON.DOWN},program);
   expect(state[bodyBase(0)+BODY.aux1]).toBe(0);
   expect(state[HEADER.counters+COUNTER.ammo]).toBe(3);
   step(state,{axis:0,buttons:BUTTON.HOLD},program);
   expect(state[bodyBase(0)+BODY.aux1]).toBe(1);
 } finally {releasePhysics(state);}
});
