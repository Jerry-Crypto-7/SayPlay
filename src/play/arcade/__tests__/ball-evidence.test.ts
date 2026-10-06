import { beforeAll, describe, expect, it } from 'vitest';
import { BODY, BUTTON, FLAG, HEADER, NO_INPUT, ROLE, bodyBase, type ArcadeEffect, type ArcadeState, type ArcadeWorld } from '../contract';
import { ballLaunchEvidence, ballScoreEvidence, keeperBlockEvidence, type BallEffectObservation, type BallLaunchEvidence } from '../ball-evidence';
import { buildWorld, instantiate, loadProgram, outcomeOf, step, type ArcadeLibrary } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { releasePhysics } from '../physics/step';
import { loadRapier } from '../physics/world';
import { BALL_GOALS, ballControl, ballLaunch, ballPitch, ballScore, type BallPitchParams } from '../pieces/ball';
import { ballBot } from '../pieces/ball-bot';
import { runBot } from '../verify';

const library: ArcadeLibrary = { controls: { ...ARCADE_LIBRARY.controls, ball: ballControl }, rules: { ...ARCADE_LIBRARY.rules, ball_launch: ballLaunch, ball_score: ballScore }, bots: { ...ARCADE_LIBRARY.bots, ball_bot: ballBot }, generators: { ...ARCADE_LIBRARY.generators, ball_pitch: ballPitch } };
function worldOf(extra: Partial<BallPitchParams> = {}): ArcadeWorld {
  const result = buildWorld({ seed: 1, ...ballPitch.parts(1, ballPitch.params.parse(extra), undefined) }, library);
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result.world;
}
/** Capture at fire, then inspect after the actual kernel applied the returned effects. */
function observedProgram(world: ArcadeWorld) {
  const pending: { rule: number; before: ArcadeState; effects: readonly ArcadeEffect[] }[] = [];
  const wrap = <P,>(piece: import('../contract').RulePiece<P>): import('../contract').RulePiece<P> => ({ ...piece, fire(ctx, params) {
    const before = ctx.state.slice(), effects = piece.fire(ctx, params);
    if (effects.length) pending.push({ rule: world.rules.findIndex(rule => rule.id === piece.id), before, effects });
    return effects;
  } });
  const program = loadProgram(world, { ...library, rules: { ...library.rules, ball_launch: wrap(ballLaunch), ball_score: wrap(ballScore) } });
  return { program, drain(after: ArcadeState): BallEffectObservation[] { return pending.splice(0).map(item => ({ ...item, world, after: after.slice() })); } };
}
function scoringRun(goal: BallPitchParams['goal']) {
  const world = worldOf({ goal }), bot = runBot(world, library, { planner: false });
  expect(bot.outcome).toBe('won');
  const inputs = new Map(bot.inputs.map(input => [input.tick, input]));
  const state = instantiate(world), observed = observedProgram(world), launches: BallLaunchEvidence[] = [];
  let score: BallEffectObservation | undefined;
  try {
    // Bot records only non-idle events; flight still advances on every empty tick.
    for (let tick = 0; tick < bot.tick; tick++) {
      step(state, inputs.get(tick) ?? NO_INPUT, observed.program);
      for (const observation of observed.drain(state)) {
        launches.push(...ballLaunchEvidence(observation));
        if (ballScoreEvidence(observation, launches).length) score = observation;
      }
    }
    expect(outcomeOf(state)).toBe('won');
    expect(score).toBeDefined();
    return { world, launches, score: score! };
  } finally { releasePhysics(state); }
}
beforeAll(async () => { await loadRapier(); });

describe('physical ball evidence', () => {
  it.each(BALL_GOALS)('%s ties actual scored sphere to its launch, target and tick', goal => {
    const { launches, score } = scoringRun(goal);
    expect(launches).toHaveLength(1);
    const evidence = ballScoreEvidence(score, launches);
    expect(evidence).toEqual([{ player: launches[0]!.player, ball: launches[0]!.ball, target: expect.any(Number), tick: expect.any(Number), launchTick: launches[0]!.tick, goal }]);
    expect(evidence[0]!.tick).toBeGreaterThan(evidence[0]!.launchTick);
    expect(score.before[bodyBase(evidence[0]!.target) + BODY.role]).toBe(ROLE.target);
    expect(ballScoreEvidence(score, [])).toEqual([]);
  });

  it('generic score, projectile flags, remote target and rising hoop cannot certify a shot', () => {
    const { launches, score } = scoringRun('hoop');
    const event = ballScoreEvidence(score, launches)[0]!;
    const rules = score.world.rules.map((rule, index) => index === score.rule ? { ...rule, id: 'generic_score' } : rule);
    expect(ballScoreEvidence({ ...score, world: { ...score.world, rules } }, launches)).toEqual([]);
    const nonphysical = Int32Array.from(score.before);
    nonphysical[bodyBase(event.ball) + BODY.flags] = nonphysical[bodyBase(event.ball) + BODY.flags]! & ~FLAG.physics;
    expect(ballScoreEvidence({ ...score, before: nonphysical }, launches)).toEqual([]);
    const projectile = Int32Array.from(score.before);
    projectile[bodyBase(event.ball) + BODY.role] = ROLE.projectile;
    expect(ballScoreEvidence({ ...score, before: projectile }, launches)).toEqual([]);
    const distant = Int32Array.from(score.before);
    distant[bodyBase(event.target) + BODY.x] = distant[bodyBase(event.target) + BODY.x]! + 100_000;
    expect(ballScoreEvidence({ ...score, before: distant }, launches)).toEqual([]);
    const rising = Int32Array.from(score.before);
    rising[bodyBase(event.ball) + BODY.vy] = 10;
    expect(ballScoreEvidence({ ...score, before: rising }, launches)).toEqual([]);
  });

  it('a separate ordinary-input probe observes a real keeper interception', () => {
    const world = worldOf({ keeper: true, goal: 'goal' });
    let block: ReturnType<typeof keeperBlockEvidence> = null;
    // Change only launch timing, never body geometry, velocity or collision flags.
    for (let delay = 0; delay <= 80 && block === null; delay += 5) {
      const state = instantiate(world), observed = observedProgram(world);
      let launch: BallLaunchEvidence | undefined;
      const keeper = Array.from({ length: state[HEADER.bodyCount]! }, (_, i) => i).find(i => state[bodyBase(i) + BODY.role] === ROLE.enemy)!;
      try {
        for (let tick = 0; tick < delay + 100 && block === null; tick++) {
          const before = state.slice();
          const input = tick < delay ? NO_INPUT : tick < delay + 30 ? { axis: 0, buttons: BUTTON.HOLD } : tick === delay + 30 ? { axis: 0, buttons: BUTTON.TAP } : NO_INPUT;
          step(state, input, observed.program);
          for (const observation of observed.drain(state)) launch ??= ballLaunchEvidence(observation)[0];
          if (launch === undefined) continue;
          block = keeperBlockEvidence(world, before, state, launch, keeper, 'probe');
          if (block !== null) {
            expect(keeperBlockEvidence(world, before, state, launch, keeper, 'winner')).toBeNull();
            const labelOnly = before.slice();
            labelOnly[bodyBase(keeper) + BODY.flags] = labelOnly[bodyBase(keeper) + BODY.flags]! & ~FLAG.solid;
            expect(keeperBlockEvidence(world, labelOnly, state, launch, keeper, 'probe')).toBeNull();
            const floor = before.slice();
            floor[bodyBase(launch.ball) + BODY.y] = 0;
            expect(keeperBlockEvidence(world, floor, state, launch, keeper, 'probe')).toBeNull();
          }
        }
      } finally { releasePhysics(state); }
    }
    expect(block).not.toBeNull();
    expect(block!.afterForward).toBeLessThan(block!.beforeForward);
  });
});
