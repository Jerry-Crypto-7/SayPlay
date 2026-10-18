import { beforeAll, expect, it } from 'vitest';
import { arcadeWorldOf } from '../compile';
import { BODY, BUTTON, COUNTER, HEADER, bodyBase } from '../contract';
import { instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { releasePhysics } from '../physics/step';
import { ballFinaleSeconds, ballParams, ballPitch } from '../pieces/ball';
import { assemblyOfCell, liveCells } from '../../compose/allowed';
import { compileRecipe } from '../../compose/compile';
import { nativeRecipeParams } from '../../director/answer-schema';
import { ballSpecParamsSchema } from '../../spec';

beforeAll(loadRapier);
const make = () => {
  const cell = liveCells().find(cell => cell.id === 'ball.score')!;
  const spec = compileRecipe(assemblyOfCell(cell));
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return { spec, world: made.world };
};
it('leaves original launch and timeout rules unchanged when tuning is omitted', () => {
  const parts = ballPitch.parts(1, ballParams.parse({}), undefined);
  expect(parts.rules).toEqual([{ id: 'ball_launch', params: { template: 1, goal: 'goal' } }, { id: 'ball_score', params: { goal: 'goal', timeout: 3600 } }]);
});
it('uses the same bounded fields at every input boundary', () => {
  for (const schema of [ballParams, ballSpecParamsSchema, nativeRecipeParams.ball]) {
    expect(schema.safeParse({ shotRecoveryTicks: 120, shotRecoveryRiseTicks: 12, paceSeconds: 90 }).success).toBe(true);
    for (const params of [{ shotRecoveryTicks: 119 }, { shotRecoveryRiseTicks: 13 }, { paceSeconds: 9 }]) expect(schema.safeParse(params).success).toBe(false);
  }
});
it('real launch recovery increases after completed goals and blocks early firing', () => {
  const { world } = make();
  for (const score of [0, 2, 4]) {
    const state = instantiate(world), program = loadProgram(world, ARCADE_LIBRARY), p = bodyBase(state[HEADER.player]!);
    try {
      state[HEADER.counters + COUNTER.score] = score;
      state[p + BODY.aux1] = 30;
      step(state, { axis: 0, buttons: BUTTON.TAP }, program);
      expect(state[HEADER.counters + COUNTER.cooldown]).toBe(168 + score * 4);
      const ammo = state[HEADER.counters + COUNTER.ammo];
      step(state, { axis: 0, buttons: BUTTON.TAP }, program);
      expect(state[HEADER.counters + COUNTER.ammo]).toBe(ammo);
    } finally { releasePhysics(state); }
  }
});
it('the deadline displayed by the HUD actually loses an idle run', () => {
  const { spec, world } = make();
  // Nová hra (P51 T4): tempo věty 15 s + hodiny na střely finále (`ballFinaleSeconds`); HUD čte totéž pravidlo `time_limit`.
  const { generator: _generator, ...params } = spec.controlParams as Record<string, unknown>;
  const seconds = Math.min(90, 15 + ballFinaleSeconds(ballParams.parse(params)));
  expect(world.rules).toContainEqual({ id: 'time_limit', params: { seconds } });
  const idle = replay(world, [], ARCADE_LIBRARY);
  expect(idle.outcome).toBe('lost');
  expect(idle.tick).toBeLessThanOrEqual(seconds * 60 + 2);
});
