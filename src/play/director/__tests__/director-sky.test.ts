import { describe, expect, it } from 'vitest';
import { liveCells } from '../../compose/allowed';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { direct } from '../index';

// P54B T11: déšť a noc z věty zůstanou i v AI verzi – návrh je ukáže hned, výměna za AI verzi je nesmí smazat.
const recipe = (id: string) => liveCells().find(cell => cell.id === id)!.recipe;

describe('the AI version keeps the light the sentence asked for', () => {
  it('rain and night from the sentence survive an authored answer', async () => {
    const sentence = 'drive a car through the city at night during a storm';
    const game = await direct(sentence, {
      branch: fakeBranch([answered({ plan: 'Race.', spec: { recipe: recipe('drive.race'), hero: 'car', setting: 'city', unmet: [] } })]),
      now: () => 0, seed: 1, maxRepairRounds: 0,
    });
    expect(game.source).toBe('authored');
    expect(game.spec.theme.weather).toBe('rain');
    expect(game.spec.theme.timeOfDay).toBe('night');
  });

  it('a sentence that says nothing about light adds nothing', async () => {
    const game = await direct('drive a car through the city', {
      branch: fakeBranch([answered({ plan: 'Race.', spec: { recipe: recipe('drive.race'), hero: 'car', setting: 'city', unmet: [] } })]),
      now: () => 0, seed: 1, maxRepairRounds: 0,
    });
    expect(game.spec.theme.weather).toBeUndefined();
    expect(game.spec.theme.timeOfDay).toBeUndefined();
  });
});
