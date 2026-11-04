/**
 * Mutátory řetězu (P56C T15). Pin hlídá, co tabulka nepozná: mutátor, který hru tiše nezmění, nebo ji udělá
 * nevyhratelnou jen u jednoho semínka, vypadá v `mutator-compat.json` stejně jako dobrý – proto se každý pár
 * tabulky na všech semínkách hraje znovu.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { BUTTON, NO_INPUT } from '@/play/arcade/contract';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { mirrorInput } from '@/play/arcade/pieces/mirror';
import { runBot } from '@/play/arcade/verify';
import { draftGenreFor } from '@/play/draft/draft';

import compat from '../mutator-compat.json';
import { MICRO, ROUND_WORLD, genreModeOf, microSpec } from '../micro';
import { COMPAT_SEEDS, COMPAT_SENTENCE, MUTATORS, MUTATOR_COMPAT, MUTATOR_IDS, mutateWorld, mutatorPairIssue } from '../mutators';

const entryOf = (key: string) => {
  const entry = MICRO.find((micro) => micro.key === key);
  if (entry === undefined) throw new Error(`no MICRO entry ${key}`);
  return entry;
};

describe('mutator table', () => {
  it('is written by the measure over the shared seeds and sentence', () => {
    expect(compat.measuredBy).toBe('evals/play/p56c/mutator-compat.measure.ts');
    expect((compat as { seeds?: readonly number[] }).seeds).toEqual(COMPAT_SEEDS);
    expect((compat as { sentence?: string }).sentence).toBe(COMPAT_SENTENCE);
  });

  it('has eleven mutators (magnet dropped, mutator-compat.md), each with a short English card and at least three microgames', () => {
    expect(MUTATOR_IDS).toHaveLength(11);
    for (const id of MUTATOR_IDS) {
      expect(MUTATORS[id].card, id).toMatch(/^[A-Z][A-Za-z ]{1,18}!$/);
      expect(MUTATOR_COMPAT[id]?.length ?? 0, id).toBeGreaterThanOrEqual(3);
    }
  });

  it('never lists a boss or an unknown microgame', () => {
    for (const id of MUTATOR_IDS) for (const key of MUTATOR_COMPAT[id] ?? []) expect(entryOf(key).boss, `${id} × ${key}`).toBeUndefined();
  });
});

describe('mirror input', () => {
  it('swaps left and right, flips the axis and is its own inverse', () => {
    const input = { buttons: BUTTON.LEFT | BUTTON.HOLD, axis: 400 };
    expect(mirrorInput(input)).toEqual({ buttons: BUTTON.RIGHT | BUTTON.HOLD, axis: -400 });
    expect(mirrorInput(mirrorInput(input))).toEqual(input);
    expect(mirrorInput(NO_INPUT)).toEqual(NO_INPUT);
  });
});

describe('spotlight', () => {
  it('leaves the world as it is', () => {
    const entry = entryOf('catch.default');
    const { genre, mode } = genreModeOf(entry);
    const made = arcadeWorldOf(microSpec(draftGenreFor(COMPAT_SENTENCE, genre, mode)!, entry, 1), 1, undefined, ROUND_WORLD);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(mutateWorld(made.world, 'spotlight')).toBe(made.world);
    const bot = runBot(made.world);
    expect(replay(made.world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
  });
});

const PAIRS = MUTATOR_IDS.flatMap((id) => (MUTATOR_COMPAT[id] ?? []).map((key) => [id, key] as const));

describe.each(PAIRS)('%s × %s', (id, key) => {
  it('bot wins in 3–8 s, idle loses, replay is equal and the hashed state moves', () => {
    expect(mutatorPairIssue(COMPAT_SENTENCE, entryOf(key), id, COMPAT_SEEDS)).toBeNull();
  });
});
