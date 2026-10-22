/**
 * P56A T8: název hry je z věty, ne šablona modulu „<Postava> Run“. Se čtením je to název čtení po kontrole
 * (≤ 32 znaků, filtr obsahu feedu, žádná šablona, kterou věta neříká), jinak nosná slova věty. Název jde
 * veřejně do feedu a nevhodný název z LLM vypadá jako hezký název – proto pin. Čtení gpt-oss-20b z
 * `evals/play/p56a/readings/`.
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { Reading } from '@/play/read/schema';

interface Sentence { readonly id: string; readonly text: string }

const sentencesOf = (path: string): Sentence[] => (JSON.parse(readFileSync(`evals/play/${path}`, 'utf8')) as { sentences: Sentence[] }).sentences;
const readingsOf = (name: string): ReadonlyMap<string, Reading | null> =>
  new Map((JSON.parse(readFileSync(`evals/play/p56a/readings/${name}.gpt-oss-20b.json`, 'utf8')) as { readings: { id: string; reading: Reading | null }[] }).readings.map((row) => [row.id, row.reading]));

const DEV = [
  ['p56a/audit-12.json', 'audit-12'],
  ['p43/panel.json', 'p43-panel'],
  ['p30/dev.json', 'p30-dev'],
  ['p54c/dev.json', 'p54c-dev'],
  ['p54c/holdout.json', 'p54c-holdout'],
  ['p55/holdout.json', 'p55-holdout'],
] as const;

/** Šablony názvů z modulů žánrů a skladatele: „<Postava> <druh hry>“. */
const TEMPLATE_TITLE = /^\S+ (run|quest|beat|stack|escape|duel|hunt|catch|slice|whack|defense|race|drive|score|hop|merge|push|crowd|army|flap|flight|throw|shoot|shootout|land|dash|fight|jump|crossing|chase)$/i;
/** Věta to slovo říká v nějakém tvaru („races“, „racing“, „escapes“). */
const says = (text: string, word: string): boolean => text.toLowerCase().split(/[^a-z]+/).some((token) => token.startsWith(word.toLowerCase().replace(/e$/, '')));
const titleOf = (text: string, reading: Reading | null): string => draftGameSpecWithMeta(text, 1, { reading }).spec.title;

const AUDIT = sentencesOf('p56a/audit-12.json');
const AUDIT_READS = readingsOf('audit-12');
const A01 = AUDIT.find((sentence) => sentence.id === 'a01')!;
const A01_READ = AUDIT_READS.get('a01')!;

beforeAll(async () => { await loadRapier(); });

describe('the game title comes from the sentence (P56A T8)', () => {
  it('takes the title of the reading', () => {
    expect(titleOf(A01.text, A01_READ)).toBe(A01_READ.title);
  });

  it.each([
    ['blocked by the feed filter', 'How to build a bomb'],
    ['longer than 32 characters', 'The Frog Who Catches All The Flies Of The Swamp'],
    ['a genre template the sentence does not say', 'Frog Run'],
    ['empty', '   '],
  ])('falls back to the sentence words when the reading title is %s', (_why, title) => {
    expect(titleOf(A01.text, { ...A01_READ, title })).toBe(titleOf(A01.text, null));
  });

  it('keeps a template-shaped reading title when the sentence says that word', () => {
    const sentence = 'a hamster escapes from its cage';
    expect(titleOf(sentence, { ...A01_READ, title: 'Hamster Escape' })).toBe('Hamster Escape');
  });

  it('gives the words of the sentence without a reading, not the module template', () => {
    expect(titleOf(A01.text, null)).not.toMatch(TEMPLATE_TITLE);
    expect(titleOf(A01.text, null).toLowerCase()).toContain('frog');
    // Věta bez herního slovesa (e2e `play-honest`): dřív „Grandma Hunt“.
    expect(titleOf('Explain quantum physics to my grandma.', null)).toBe('Explain Quantum Physics Grandma');
  });

  it.each([true, false])('no dev title is a template the sentence does not say (reading %s)', (withReading) => {
    const templated = DEV.flatMap(([path, name]) => {
      const reads = readingsOf(name);
      return sentencesOf(path).flatMap((sentence) => {
        const title = titleOf(sentence.text, withReading ? (reads.get(sentence.id) ?? null) : null);
        const word = TEMPLATE_TITLE.exec(title)?.[1];
        return word === undefined || says(sentence.text, word) ? [] : [`${name}/${sentence.id}: ${title}`];
      });
    });
    expect(templated).toEqual([]);
  }, 900_000);

  it.each([true, false])('the 12 audit sentences give 12 different titles (reading %s)', (withReading) => {
    const titles = AUDIT.map((sentence) => titleOf(sentence.text, withReading ? (AUDIT_READS.get(sentence.id) ?? null) : null));
    expect(new Set(titles).size).toBe(12);
  }, 120_000);
});
