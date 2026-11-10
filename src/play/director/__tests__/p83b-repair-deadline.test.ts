import { describe, expect, it } from 'vitest';
import { liveCells } from '../../compose/allowed';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { MIN_REPAIR_MS, direct } from '../index';

// P83B T3: the blind review saw "Fixing one thing…" for 57 s – four repair
// rounds after the first answer. Under a deadline a round starts only with
// MIN_REPAIR_MS left; the game then ends as if the rounds ran out.
const SENTENCE = 'a fox runs and sings';
const runner = { plan: 'Run.', spec: { recipe: liveCells().find((cell) => cell.id === 'runner.default')!.recipe, hero: 'fox', setting: 'forest', unmet: [] } };
const patch = [{ op: 'replace', path: '/title', value: 'Singing Fox' }];

describe('P83B: repair rounds stop at the director deadline', () => {
  it('a round starts with exactly MIN_REPAIR_MS left', async () => {
    const branch = fakeBranch([answered(runner), answered(patch)]);
    const game = await direct(SENTENCE, { branch, now: () => 0, seed: 1, maxRepairRounds: 1, deadline: MIN_REPAIR_MS });
    expect(branch.calls).toHaveLength(2);
    expect(game.repairRounds).toBe(1);
  });

  it('with less left no round starts and the game ends as with no rounds at all', async () => {
    const late = fakeBranch([answered(runner), answered(patch)]);
    const game = await direct(SENTENCE, { branch: late, now: () => 0, seed: 1, maxRepairRounds: 1, deadline: MIN_REPAIR_MS - 1 });
    const none = await direct(SENTENCE, { branch: fakeBranch([answered(runner)]), now: () => 0, seed: 1, maxRepairRounds: 0 });
    expect(late.calls).toHaveLength(1);
    expect(game.repairRounds).toBe(0);
    expect({ source: game.source, reason: game.fallbackReason, spec: game.spec }).toEqual({ source: none.source, reason: none.fallbackReason, spec: none.spec });
  });

  it('the clock counts the first call: a round due after it is dropped', async () => {
    let clock = 0;
    const branch = fakeBranch([answered(runner), answered(patch)]);
    const slow = { ...branch, generate: async (call: Parameters<typeof branch.generate>[0]) => ((clock += 40_000), branch.generate(call)) };
    const game = await direct(SENTENCE, { branch: slow, now: () => clock, seed: 1, maxRepairRounds: 4, deadline: 42_000 });
    expect(branch.calls).toHaveLength(1);
    expect(game.repairRounds).toBe(0);
  });
});
