/**
 * Karty cílů (P23-C T5): akce runtime → karty, první a druhé klepnutí,
 * klávesy. Vlastní cíl aktéra (`moveTo visitor`) kartu nedostane; druhé
 * klepnutí bez `pickup`/`use` ve světě nic nepošle.
 */

import { describe, expect, it } from 'vitest';

import type { RuntimeAction } from '@/worldstream/runtime-input';

import { keyAction, playerActor, secondTapLabel, tapAction, targetCards } from '../targets';

const ACTIONS: readonly RuntimeAction[] = [
  { actor: 'visitor', actionId: 'moveTo', target: 'visitor' },
  { actor: 'visitor', actionId: 'moveTo', target: 'well' },
  { actor: 'visitor', actionId: 'moveTo', target: 'lever' },
  { actor: 'visitor', actionId: 'use', target: 'lever' },
  { actor: 'visitor', actionId: 'moveTo', target: 'gem' },
  { actor: 'visitor', actionId: 'pickup', target: 'gem' },
  { actor: 'roomba', actionId: 'moveTo', target: 'well' },
];

const OBJECTS = [
  { stableId: 'well', label: 'the light well' },
  { stableId: 'leverShape', label: 'the brass lever', binding: { entityId: 'lever' } },
];

describe('targetCards', () => {
  it('one card per target of the player, labelled from the blueprint, never the actor itself', () => {
    const cards = targetCards(ACTIONS, OBJECTS);
    expect(cards.map((card) => card.id)).toEqual(['well', 'lever', 'gem']);
    expect(cards.map((card) => card.label)).toEqual(['the light well', 'the brass lever', 'gem']);
    expect(cards.map(secondTapLabel)).toEqual(['Move here', 'Use', 'Pick up']);
    expect(playerActor(ACTIONS)).toBe('visitor');
  });

  it('is empty for a world without a moving actor', () => {
    expect(targetCards([{ actor: 'x', actionId: 'use', target: 'y' }], [])).toEqual([]);
  });
});

describe('tapAction', () => {
  const cards = targetCards(ACTIONS, OBJECTS);
  const [well, lever] = cards;

  it('first tap moves and selects; second tap on the same card sends the declared second action', () => {
    const first = tapAction(lever!, null);
    expect(first.action).toEqual({ actor: 'visitor', actionId: 'moveTo', target: 'lever' });
    expect(first.selected).toBe('lever');
    const second = tapAction(lever!, first.selected);
    expect(second.action).toEqual({ actor: 'visitor', actionId: 'use', target: 'lever' });
  });

  it('second tap on a move-only card sends nothing and keeps the selection', () => {
    const second = tapAction(well!, 'well');
    expect(second.action).toBeNull();
    expect(second.selected).toBe('well');
  });

  it('tapping another card is a move to it', () => {
    expect(tapAction(well!, 'lever').action?.actionId).toBe('moveTo');
  });
});

describe('keyAction', () => {
  const cards = targetCards(ACTIONS, OBJECTS);

  it('digits pick a card by position, Space and E act on the selected card only when the world offers it', () => {
    expect(keyAction('2', cards, null)).toEqual({ action: { actor: 'visitor', actionId: 'moveTo', target: 'lever' }, selected: 'lever' });
    expect(keyAction('e', cards, 'lever')?.action.actionId).toBe('use');
    expect(keyAction(' ', cards, 'lever')).toBeNull();
    expect(keyAction(' ', cards, 'gem')?.action.actionId).toBe('pickup');
    expect(keyAction('9', cards, null)).toBeNull();
    expect(keyAction('e', cards, null)).toBeNull();
  });
});
