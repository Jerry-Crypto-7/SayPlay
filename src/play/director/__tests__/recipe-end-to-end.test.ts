import { describe, expect, it } from 'vitest';
import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
import { liveCells } from '../../compose/allowed';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { direct } from '../index';

function answer(unmet: readonly { actor: string; verb: string; object: string | null }[] = []) {
  return { plan: 'Run through the forest.', spec: { recipe: liveCells().find(cell => cell.id === 'runner.default')!.recipe, hero: 'fox', setting: 'forest', unmet } };
}
describe('recipe answers through direct', () => {
  it('keeps a native glide assembly when the model answers in the legacy genre format', async () => {
    const game = await direct('a fish swims through a coral reef', { branch: fakeBranch([answered({ plan: 'Swim through the reef.', spec: { genre: 'voyage', mode: 'race', hero: 'fish', setting: 'coral reef' } })]), now: () => 0, seed: 1, maxRepairRounds: 0 });
    expect(game.source).toBe('authored');
    expect(game.spec.control).toBe('glide');
    expect(game.unmet).toEqual([]);
  });
  it('compiles a live recipe and verifies the returned game without a supplied robot double', async () => {
    const game = await direct('a fox runs through a forest', { branch: fakeBranch([answered(answer())]), now: () => 0, seed: 1, maxRepairRounds: 0 });
    expect(game.source).toBe('authored'); expect(game.fallbackReason).toBeNull(); expect(game.unmet).toEqual([]);
    const made = arcadeWorldOf(game.spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(verifyArcade(made.world, undefined, made.roleBindings).publishEligible).toBe(true);
  });
  it('a model admission stays an unmet triple rather than becoming a witness', async () => {
    const omitted = { actor: 'fox', verb: 'sing', object: null };
    const game = await direct('a fox runs and sings', { branch: fakeBranch([answered(answer([omitted]))]), now: () => 0, maxRepairRounds: 0 });
    expect(game.source).toBe('authored'); expect(game.unmet).toContainEqual(omitted);
  });
  it('repair receives the full original intent and a cosmetic patch cannot prove singing', async () => {
    const branch = fakeBranch([answered(answer()), answered([{ op: 'replace', path: '/title', value: 'Singing Fox' }])]);
    const game = await direct('a fox runs and sings', { branch, now: () => 0, maxRepairRounds: 1 });
    expect(branch.calls).toHaveLength(2);
    expect(branch.calls[0]!.request?.user).toContain('FULL INTENT');
    expect(branch.calls[1]!.request?.user).toContain('ORIGINAL INTENT');
    expect(branch.calls[1]!.request?.user).toContain('sing');
    expect(game.unmet).toContainEqual({ actor: 'fox', verb: 'sing', object: null });
    expect(game.failure?.reason).toBe('ACTION_LOST');
  });
  it('unknown recipe movement is refused instead of silently reading the old genre', async () => {
    const body = answer();
    const game = await direct('a fox runs', { branch: fakeBranch([answered({ ...body, spec: { ...body.spec, recipe: { ...body.spec.recipe, move: 'teleport' }, genre: 'runner', mode: 'default' } })]), now: () => 0, maxRepairRounds: 0 });
    expect(game.source).toBe('draft'); expect(game.fallbackReason).toBe('MALFORMED');
  });
});
