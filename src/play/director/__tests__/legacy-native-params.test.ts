import { describe, expect, it } from 'vitest';
import { liveCells } from '../../compose/allowed';
import { draftGameSpecWithMeta } from '../../draft';
import { actionEvidence, missingActions } from '../../fidelity/action-evidence';
import { extractIntent } from '../../intent/extract';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { direct } from '../index';
import { readLegacyRecipeContent, readRecipeContent } from '../read';

const cell = () => liveCells().find(item => item.recipe.move === 'walk' && item.recipe.objective === 'escape')!;

describe('validated legacy content migrates to native parameters', () => {
  it('keeps the named dog in an authored native chase and truthfully reports every missing action', async () => {
    const sentence = 'A kid pops balloons at a fair while a dog chases him';
    const quick = draftGameSpecWithMeta(sentence);
    expect(quick.genre?.params).toMatchObject({ chasers: 1 });
    const game = await direct(sentence, { branch: fakeBranch([answered({ plan: 'Keep the named chase.', spec: { ...quick.genre, params: { chasers: 1 } } })]), now: () => 0, maxRepairRounds: 0 });
    expect(game.source).toBe('authored');
    expect(game.spec.control).toBe('walker');
    expect(game.spec.roles).toContainEqual(expect.objectContaining({ kind: 'chaser', label: 'dog' }));
    expect(game.unmet).toEqual(missingActions(extractIntent(sentence), await actionEvidence(game.spec, 1)));
  });

  it('preserves shared bounded parameters and authored content while dropping legacy-only knobs', () => {
    const selected = cell();
    const content = { ...selected.preset, hero: 'kid', setting: 'fair', params: { lives: 3, chasers: 1 }, heroAction: 'throw' as const, ruleRoles: [{ id: 'bell', label: 'bell', kind: 'target' as const }], rules: [{ id: 'tick', verb: 'tick', when: { every: 60 }, do: [{ score: 1 }] }] };
    const read = readLegacyRecipeContent(selected, content);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.params).toEqual({ lives: 3 });
    expect(read.value).toMatchObject({ hero: content.hero, setting: content.setting, heroAction: content.heroAction, ruleRoles: content.ruleRoles, rules: content.rules });
  });

  it('rejects a shared parameter outside the native bounds', () => {
    const selected = cell();
    expect(readLegacyRecipeContent(selected, { ...selected.preset, params: { lives: 10, chasers: 1 } }).ok).toBe(false);
  });

  it('still rejects the same legacy-only key on an explicit recipe answer', () => {
    const selected = cell();
    expect(readRecipeContent(selected, { ...selected.preset, params: { chasers: 1 } }).ok).toBe(false);
    expect(readRecipeContent(selected, { ...selected.preset, params: { arbitraryUnknown: 7 } }).ok).toBe(false);
  });
});
