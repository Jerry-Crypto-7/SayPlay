import { describe, expect, it } from 'vitest';
import { direct } from '../index';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { draftGameSpecWithMeta } from '../../draft';
import { isAmmo } from '../../genre/throw';
import { actionEvidence, missingActions } from '../../fidelity/action-evidence';
import { extractIntent } from '../../intent/extract';

describe('composed answers preserve sentence content and actual omissions', () => {
  it.each(['omitted', 'wrong'] as const)('%s ammo becomes the stated pinecone, while unsupported clauses remain unmet', async kind => {
    const sentence = 'a squirrel grabs acorns, dodges owls and throws pinecones at a fox';
    const draft = draftGameSpecWithMeta(sentence);
    if (draft.genre == null) throw new Error('Expected sentence content');
    const cast = kind === 'omitted' ? draft.genre.cast!.filter(item => !isAmmo(item)) : draft.genre.cast!.map(item => isAmmo(item) ? { ...item, label: 'snowball' } : item);
    const result = await direct(sentence, { branch: fakeBranch([answered({ plan: 'content', spec: { ...draft.genre, cast } })]), now: () => 0 });
    expect(result.source).toBe('authored');
    expect(result.spec.roles.find(role => role.id === 'ball')?.label).toBe('pinecone');
    const unmet = missingActions(extractIntent(sentence), await actionEvidence(result.spec, 1));
    expect(result.unmet).toEqual(unmet);
    expect(unmet.length).toBeGreaterThan(0);
    expect(result.fallbackReason).toBe('VERB_UNPROVED');
  });
});
