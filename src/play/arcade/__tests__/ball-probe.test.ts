import { beforeAll, expect, it } from 'vitest';
import { BODY, HEADER, ROLE, bodyBase, type InputEvent } from '../contract';
import { ballLaunchEvidence, keeperBlockEvidence, type BallLaunchEvidence } from '../ball-evidence';
import { buildWorld, hashArcade, instantiate, loadProgram, replay, step, type ArcadeLibrary } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { releasePhysics } from '../physics/step';
import { BALL_GOALS, ballControl, ballLaunch, ballPitch, ballScore } from '../pieces/ball';
import { ballBot } from '../pieces/ball-bot';
import { ballKeeperProbeInput } from '../pieces/ball-probe';

const library: ArcadeLibrary = { ...ARCADE_LIBRARY, controls: { ...ARCADE_LIBRARY.controls, ball: ballControl }, rules: { ...ARCADE_LIBRARY.rules, ball_launch: ballLaunch, ball_score: ballScore }, bots: { ...ARCADE_LIBRARY.bots, ball_bot: ballBot } };
beforeAll(async () => { await loadRapier(); });
it.each(BALL_GOALS.flatMap(goal => Array.from({ length: 20 }, (_, n) => ({ goal, seed: n + 1 }))))('$goal seed $seed keeper physically blocks ordinary probe inputs', ({ goal, seed }) => {
  const built = buildWorld({ seed, ...ballPitch.parts(seed, ballPitch.params.parse({ goal, keeper: true }), undefined) }, library);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const world = built.world, state = instantiate(world), program = loadProgram(world, library);
  const keeper = Array.from({ length: state[HEADER.bodyCount]! }, (_, i) => i).find(i => state[bodyBase(i) + BODY.role] === ROLE.enemy)!;
  const inputs: InputEvent[] = [];
  let launch: BallLaunchEvidence | undefined, block: ReturnType<typeof keeperBlockEvidence> = null;
  try {
    for (let tick = 0; tick < 500 && block === null; tick++) {
      const input = ballKeeperProbeInput(world, state, keeper), before = state.slice();
      if (input.axis || input.buttons) inputs.push({ tick, ...input });
      const effects = step(state, input, program);
      // Launch is the only spawning rule; its real applied effects identify the sphere.
      launch = ballLaunchEvidence({ world, rule: world.rules.findIndex(rule => rule.id === 'ball_launch'), before, after: state, effects })[0] ?? launch;
      if (launch !== undefined) block = keeperBlockEvidence(world, before, state, launch, keeper, 'probe');
    }
    expect(block, JSON.stringify({ goal, seed, launch, keeper: Array.from(state.slice(bodyBase(keeper), bodyBase(keeper) + 14)), inputs: inputs.slice(0, 3) })).not.toBeNull();
    expect(block!.afterForward).toBeLessThan(block!.beforeForward);
    expect(replay(world, inputs, library, state[HEADER.tick]!).hash).toBe(hashArcade(state));
  } finally { releasePhysics(state); }
});
