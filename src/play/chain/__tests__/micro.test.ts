/**
 * Tabulka mikroher řetězu (P56C T4). Pin hlídá, co kód nepozná: mikrohra, kterou vyhraje i nečinný hráč,
 * nebo kterou robot vyhraje až za 20 s, vypadá v tabulce stejně jako správná.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { ARCADE_HZ } from '@/play/arcade/contract';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { runBot } from '@/play/arcade/verify';
import { draftGenreFor } from '@/play/draft/draft';

import { MICRO, type MicroEntry, genreModeOf, microSpec } from '../micro';

const SEEDS = [1, 2, 8, 9, 13, 20] as const;
/** Poslední kolo nejdelšího řetězu (5 kol) – nejkratší hodiny přežití. */
const LAST_ROUND = 4;
const SENTENCE = 'a fox in a forest';

const specOf = (entry: MicroEntry, round: number) => {
  const { genre, mode } = genreModeOf(entry);
  const draft = draftGenreFor(SENTENCE, genre, mode);
  if (draft === null) throw new Error(`no draft for ${entry.key}`);
  return microSpec(draft, entry, round);
};

describe('MICRO table', () => {
  it('has at least 12 entries over at least 10 controls, unique keys and three bosses', () => {
    expect(MICRO.length).toBeGreaterThanOrEqual(12);
    expect(new Set(MICRO.map((entry) => entry.key)).size).toBe(MICRO.length);
    expect(new Set(MICRO.map((entry) => entry.control)).size).toBeGreaterThanOrEqual(10);
    expect(MICRO.filter((entry) => entry.boss === true).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps physics and long loops out of the chain', () => {
    for (const entry of MICRO) {
      expect(['ball', 'merge', 'push']).not.toContain(entry.control);
      const { genre, mode } = genreModeOf(entry);
      expect(genre).not.toBe('quest');
      expect(`${genre}.${mode}`).not.toBe('voyage.land');
    }
  });

  it('names the control the compiled round really plays and a short English card', () => {
    for (const entry of MICRO) {
      expect(specOf(entry, 0).control, entry.key).toBe(entry.control);
      expect(entry.card, entry.key).toMatch(/^[A-Z][A-Za-z ]{1,18}!$/);
    }
  });
});

describe.each(MICRO.map((entry) => [entry.key, entry] as const))('%s', (_key, entry) => {
  const most = (entry.boss === true ? 15 : 8) * ARCADE_HZ;
  const rounds = entry.kind === 'survive' ? [0, LAST_ROUND] : [0];

  it.each(rounds.flatMap((round) => SEEDS.map((seed) => [round, seed] as const)))('round %i seed %i: bot wins in 3–8 s, idle loses, replay is equal', (round, seed) => {
    const made = arcadeWorldOf(specOf(entry, round), seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const bot = runBot(made.world);
    expect(bot.outcome).toBe('won');
    expect(bot.tick).toBeGreaterThanOrEqual(3 * ARCADE_HZ);
    expect(bot.tick).toBeLessThanOrEqual(most);
    expect(replay(made.world, [], ARCADE_LIBRARY).outcome).toBe('lost');
    const first = replay(made.world, bot.inputs, ARCADE_LIBRARY);
    const second = replay(made.world, bot.inputs, ARCADE_LIBRARY);
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toBe(bot.hash);
  });
});
