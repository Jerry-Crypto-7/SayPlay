import { describe, expect, it } from 'vitest';
import { assemblyOfCell, liveCells } from '../../compose/allowed';
import { compileRecipe } from '../../compose/compile';
import { recipeKey } from '../../compose/recipe';
import { answered, fakeBranch } from '../__fixtures__/branch';
import answers from '../__fixtures__/p83b-walk-counts.json';
import { direct } from '../index';
import { readRecipeAnswer, readRecipeContent } from '../read';

// P83B T2: the strict answer schema makes the model fill `counts` for a walk
// recipe; the reader used to reject the whole game for it ("garbled" in the
// blind review). Live answers captured on 10. 11.
describe('P83B: a walk answer with a count the recipe does not read', () => {
  for (const { sentence, raw } of answers) {
    it(`becomes the AI game in one call, not MALFORMED: ${sentence}`, async () => {
      const branch = fakeBranch([answered(raw)]);
      const game = await direct(sentence, { branch, now: () => 0, seed: 1, maxRepairRounds: 0 });
      expect(game.fallbackReason).not.toBe('MALFORMED');
      expect(game.failure?.stage).not.toBe('read');
      expect(game.source).toBe('authored');
      expect(game.spec.control).toBe('walker');
      expect(game.spec.theme.setting).toBe(raw.spec.setting);
      expect(branch.calls).toHaveLength(1);
    });
  }

  it('authored rules keep the logic block they name', () => {
    const read = readRecipeAnswer(answers[0]!.raw);
    if (!read.ok) throw new Error(read.detail);
    const cell = liveCells().find(candidate => recipeKey(candidate.recipe) === recipeKey(read.value.recipe))!;
    const { recipe: _recipe, unmet: _unmet, ...content } = read.value;
    const checked = readRecipeContent(cell, content);
    if (!checked.ok) throw new Error(checked.issues.join('; '));
    const spec = compileRecipe({ ...assemblyOfCell(cell, checked.value), ...read.value.recipe });
    expect(spec.rules).toHaveLength(3);
    expect(spec.logic).toEqual({ timers: [{ id: 'hall_entry' }], phases: [{ id: 'approach' }, { id: 'guarded_hall' }] });
  });
});
