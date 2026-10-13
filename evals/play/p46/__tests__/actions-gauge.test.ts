/**
 * Měřidlo „sloveso → akce“ (P46A T2): věta bez slovesa akce akci nechce,
 * slovesa krást/uhnout/krýt se ji chtějí a svět se střelbou ukáže stisk
 * i zásah. Měřidlo, které by bralo doplněk bez nepřátel nebo bez zásahu
 * jako splněnou akci, by ukázalo pokrok, který hráč neuvidí.
 */

import { describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '@/play/draft';

import { actionRowOf, actionSentences, wantedActions } from '../actions';

describe('P46 verb-to-action gauge', () => {
  it('wants no action from a sentence without an action verb', () => {
    expect(wantedActions('A frog hops across a pond to reach the lily')).toEqual([]);
  });

  it('reads the verbs the intent table lacks, in sentence order and at most two', () => {
    expect(wantedActions('A rabbit steals carrots and runs from a fox')).toEqual(['grab']);
    expect(wantedActions('A turtle blocks falling rocks with its shell')).toEqual(['shield']);
    expect(wantedActions('A ninja dashes over rooftops and kicks robot guards')).toEqual(['dash', 'strike']);
    expect(wantedActions('Amanita mushrooms fight against bulls, flee from them, and shoot them.')).toEqual(['strike', 'shoot']);
  });

  it('counts a hand-built shooting runner as having, using and firing the action', async () => {
    const text = 'A rabbit runs through a meadow and shoots wolves';
    const { spec } = draftGameSpecWithMeta(text, 1);
    const row = await actionRowOf({ id: 't', text }, { ...spec, control: 'runner', addons: ['shoot'] });
    expect(row.wanted).toEqual(['shoot']);
    expect(row.hasAction).toBe(true);
    expect(row.botUsed).toBe(true);
    expect(row.verbFired).toBe(true);
  });

  it('does not credit an action the game lacks', async () => {
    const text = 'A rabbit steals carrots and runs from a fox';
    // Rychlá verze dá králíkovi Grab (P46A T8) – hra bez akce je tentýž spec bez ní.
    const { abilities: _abilities, ...spec } = draftGameSpecWithMeta(text, 1).spec;
    const row = await actionRowOf({ id: 't', text }, { ...spec, control: 'runner', addons: [] });
    expect(row.hasAction).toBe(false);
    expect(row.botUsed).toBe(false);
    expect(row.verbFired).toBe(false);
  });

  it('measures the P45 panel plus the 20 action sentences', () => {
    expect(actionSentences()).toHaveLength(60);
  });
});
