/**
 * Prompt čtečky (P58B T6): žánr podle toho, co hráč dělá, protipříklady pastí a 6–10 ručně psaných příkladů. Příklad,
 * který sdílí kus věty s dev nebo zapečetěnou sadou, by čtečku učil na větách, na kterých se měří – proto pin překryvu.
 * Na výstup jde jen číslo příkladu, nikdy věta sady.
 */

import { describe, expect, it } from 'vitest';

import { knownSets, textsOf } from '../../../../evals/play/p58b/seal';
import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { PROMPT_EXAMPLES, readerSystemPrompt } from '../prompt';
import { READY_GENRE_MODES } from '../schema';

/** Kus věty, který příklad se sadou sdílet nesmí: pět slov za sebou. */
const RUN = 5;
const runs = (text: string): string[] => {
  const words = normalizeSentence(text).split(' ');
  return words.slice(0, Math.max(0, words.length - RUN + 1)).map((_, at) => words.slice(at, at + RUN).join(' '));
};

describe('reader prompt examples', () => {
  const prompt = readerSystemPrompt();

  it('has 6 to 10 examples, each a playing mode or null, each written into the prompt', () => {
    expect(PROMPT_EXAMPLES.length).toBeGreaterThanOrEqual(6);
    expect(PROMPT_EXAMPLES.length).toBeLessThanOrEqual(10);
    const modes = READY_GENRE_MODES.flatMap(({ genre, modes }) => modes.map((mode) => `${genre}.${mode}`));
    for (const { sentence, genre } of PROMPT_EXAMPLES) {
      if (genre !== null) expect(modes).toContain(genre);
      expect(prompt).toContain(`"${sentence}" => ${genre ?? 'null'}`);
    }
    // Aspoň dvě pasti bez žánru: příklady mají učit i „nic nesedí“.
    expect(PROMPT_EXAMPLES.filter((example) => example.genre === null).length).toBeGreaterThanOrEqual(2);
  });

  it('shares no five-word run with any dev, opened or sealed sentence set', () => {
    const sets = [...knownSets(), 'p58b/holdout.json'];
    // Prohledání samo něco najde: bez dev sad a zapečetěné sady by nulový průnik nic neříkal.
    expect(sets).toEqual(expect.arrayContaining(['p30/dev.json', 'p55/holdout.json', 'p56a/holdout.json', 'p58b/holdout.json']));
    const known = new Set(sets.flatMap(textsOf).flatMap(runs));
    // Kontrola sama překryv pozná: kus věty dev sady se přepisem velikosti a interpunkce neschová.
    expect(runs(`Look, ${textsOf('p56a/holdout.json')[0]!.toUpperCase()}!`).some((run) => known.has(run))).toBe(true);
    expect(PROMPT_EXAMPLES.map(({ sentence }, index) => (runs(sentence).some((run) => known.has(run)) ? index : -1)).filter((index) => index >= 0)).toEqual([]);
  });

  // Strop plánu je 2 000 tokenů promptu; 6 000 znaků je pod ním i při husté tokenizaci id (~3 znaky na token).
  it('stays at most 6,000 characters – under the 2,000-token ceiling', () => {
    expect(prompt.length).toBeLessThanOrEqual(6000);
  });

  it('names the plays no genre fits, so a lure word alone does not pick one', () => {
    expect(prompt).toMatch(/null.*turn-based.*cards/s);
    expect(prompt).toMatch(/null.*(?:photo|picture)/s);
  });
});
