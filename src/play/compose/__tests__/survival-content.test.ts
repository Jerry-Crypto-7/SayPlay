import { expect, it } from 'vitest';
import { draftGameSpecWithMeta } from '../../draft';
import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
import { assemblyOfCell, liveCells } from '../allowed';

it('keeps an explicit sixty-second survival objective playable instead of falling back to collection', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const draft = draftGameSpecWithMeta('Survive 60 seconds while red floor tiles pulse dangerously.', seed);
    expect(draft.composition?.recipe.objective).toBe('survive');
    expect(draft.spec.objective).toMatchObject({ kind: 'survive', seconds: 60 });
    const made = arcadeWorldOf(draft.spec, seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.publishEligible).toBe(true);
    expect(verdict.bot.tick).toBe(3600);
    expect(verdict.witnesses.some(w => w.verb === 'survive' && w.object === null)).toBe(true);
    expect(draft.composition?.unmet.some(item => item.verb === 'survive')).toBe(false);
  }
});

it('lets explicit authored pressure override the duration-specific defaults', () => {
  const cell = liveCells().find(cell => cell.id === 'arena.escape')!;
  const content = { ...cell.preset, params: { seconds: 60, chaserSpeed: 70, lives: 2 } };
  expect(assemblyOfCell(cell, content).content.params).toMatchObject(content.params);
});
