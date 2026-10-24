/**
 * Zapečetěná sada viditelnosti P58A (T1): 80 vět nezávislého autora, každá s hrdinou a protivníkem nebo věcí,
 * polovina se zvířetem či postavou, pro kterou katalog v den zapečetění neměl přesný model. Do T9 ji kromě tohoto
 * testu a výběru při pečetění nic nečte a test na výstup dává jen id. Průnik s kteroukoli sadou, na které se ladí
 * nebo kterou kdy kdo četl, by z brány udělal měření na tréninkových větách.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { nounsOf } from '../../p56a/visible.mjs';
import { KNOWN_SETS, P58A_HOLDOUT_SHA256, outsideCatalog, sha256Lf } from '../seal';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p58a');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

interface Sentence {
  readonly id: string; readonly text: string; readonly hero: string | null; readonly foe: string | null; readonly item: string | null;
  /** Výběr při pečetění: některé ze slov soudce (`nounsOf`) nemělo v katalogu přesný model (`level` ≠ `identity`). */
  readonly outside: boolean;
}
const holdout = (): Sentence[] => (JSON.parse(readLf(join(DIR, 'holdout.json'))) as { sentences: Sentence[] }).sentences;
const textsOf = (path: string): string[] => {
  const json = JSON.parse(readLf(join(PLAY, path))) as { sentences: { text: string }[] } | { text: string }[];
  return (Array.isArray(json) ? json : json.sentences).map((s) => s.text);
};

describe('P58A sealed visibility holdout', () => {
  it('matches its recorded SHA-256, also written in the README', () => {
    expect(sha256Lf(readLf(join(DIR, 'holdout.json')))).toBe(P58A_HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(P58A_HOLDOUT_SHA256);
  });

  it('has 80 sentences, each naming a hero and a foe or an item', () => {
    const sentences = holdout();
    expect(sentences).toHaveLength(80);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(80);
    const label = (value: string | null): boolean => value === null || (typeof value === 'string' && value.trim() !== '');
    const bad = sentences.filter((s) => typeof s.text !== 'string' || typeof s.hero !== 'string' || s.hero.trim() === '' || ![s.foe, s.item].every(label)
      || (s.foe ?? s.item) === null || typeof s.outside !== 'boolean');
    expect(bad.map((s) => s.id)).toEqual([]);
    expect(sentences.every((s) => nounsOf(s).length === 2)).toBe(true);
  });

  it('puts an animal or character the catalog had no exact model for into half of the sentences', () => {
    const sentences = holdout();
    expect(sentences.filter((s) => s.outside)).toHaveLength(40);
    // Katalog po pečetění jen roste, takže „uvnitř“ platí dál; „mimo“ ověřil výběr v den pečetění (README).
    expect(sentences.filter((s) => !s.outside && outsideCatalog(s)).map((s) => s.id)).toEqual([]);
  });

  it('shares no sentence with any known set in evals/play, nor within itself', () => {
    const known = new Set(KNOWN_SETS.flatMap(textsOf).map(normalizeSentence));
    // Kontrola sama kolizi pozná: věta auditu se přepisem velikosti a interpunkce neschová.
    expect(known.has(normalizeSentence(`${textsOf('p56a/holdout.json')[0]!.toUpperCase()}!`))).toBe(true);
    const sentences = holdout();
    // Jen id, ne věta: sada se do výstupu testu nedostane.
    expect(sentences.filter((s) => known.has(normalizeSentence(s.text))).map((s) => s.id)).toEqual([]);
    expect(new Set(sentences.map((s) => normalizeSentence(s.text))).size).toBe(sentences.length);
  });
});
