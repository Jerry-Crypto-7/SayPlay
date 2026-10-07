import { describe, expect, it } from 'vitest';
import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
import { liveCells } from '../../compose/allowed';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { direct } from '../index';

// Co věta výslovně zakáže, nesmí se ve vydané hře odehrát – ať režisér odpoví receptem, nebo starým žánrem.
async function playedVerbs(sentence: string, body: unknown): Promise<string[]> {
  const game = await direct(sentence, { branch: fakeBranch([answered(body)]), now: () => 0, seed: 1, maxRepairRounds: 0 });
  const made = arcadeWorldOf(game.spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return verifyArcade(made.world, undefined, made.roleBindings).witnesses.map(witness => witness.verb);
}

const recipe = (id: string) => liveCells().find(cell => cell.id === id)!.recipe;

describe('the director never ships a forbidden action', () => {
  it('a recipe that races is refused for "without racing"', async () => {
    const verbs = await playedVerbs('drive a car without racing', { plan: 'Race.', spec: { recipe: recipe('drive.race'), hero: 'car', setting: 'city', unmet: [] } });
    expect(verbs).not.toContain('race');
  });

  it('a recipe that shoots is refused for "doesn\'t shoot"', async () => {
    const verbs = await playedVerbs('a fox runs through a forest but doesn\'t shoot', { plan: 'Run and shoot.', spec: { recipe: recipe('runner.default+shoot_at'), hero: 'fox', setting: 'forest', unmet: [] } });
    expect(verbs).not.toContain('shoot');
  });

  it('a legacy cast that shoots is refused for "doesn\'t shoot"', async () => {
    const body = { plan: 'Run and shoot.', spec: { genre: 'runner', mode: 'default', hero: 'fox', setting: 'forest', cast: [{ label: 'robot', does: 'shoot_at' }] } };
    const verbs = await playedVerbs('a fox runs through a forest but doesn\'t shoot', body);
    expect(verbs).not.toContain('shoot');
  });
});
