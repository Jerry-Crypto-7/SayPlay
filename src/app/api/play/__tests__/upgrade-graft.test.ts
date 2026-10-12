import { describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '@/play/draft';

import { onQuickGame } from '../_upgrade';

// Demo 12. 10.: režisér vybral jiný žánr než rychlá verze a akci z věty ztratil – AI verze padla.
describe('onQuickGame: the quick game carries the director look', () => {
  const quick = draftGameSpecWithMeta('a knight fights a dragon at the castle gates').spec;
  const ai = draftGameSpecWithMeta('a wizard explores a dark cave').spec;

  it('keeps the quick control and mechanics, takes the director title and theme', () => {
    const grafted = onQuickGame(quick, ai);
    expect(grafted).not.toBeNull();
    expect(grafted!.control).toBe(quick.control);
    expect(grafted!.controlParams).toEqual(quick.controlParams);
    expect(grafted!.mechanics).toEqual(quick.mechanics);
    expect(grafted!.title).toBe(ai.title);
    expect(grafted!.theme).toEqual(ai.theme);
    expect(grafted!.roles.slice(0, quick.roles.length)).toEqual(quick.roles);
  });

  it('keeps the quick rules when the director wrote none', () => {
    const grafted = onQuickGame(quick, { ...ai, rules: undefined, things: undefined, logic: undefined });
    expect(grafted!.rules).toEqual(quick.rules);
    expect(grafted!.logic).toEqual(quick.logic);
  });
});
