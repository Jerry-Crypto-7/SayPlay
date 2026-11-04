/**
 * P70A T1: souhrn `before.json` a tabulka `before.md` přepočítané ze surových řádků, ne opsané. Hlídá i složení
 * měření (každý hratelný žánr, 5 vět × 10 seedů) a pořadí vítězný robot ≥ začátečník na každém žánru.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type GenreSummary, type Pick, type Row, SEEDS, SENTENCES_PER_GENRE, playableGenres, summarize, table } from '../beginner';

const DIR = join(process.cwd(), 'evals', 'play', 'p70a');
const read = (name: string): string => readFileSync(join(DIR, name), 'utf8').replace(/\r\n/g, '\n');

interface Doc { readonly seeds: number; readonly picks: readonly Pick[]; readonly summary: readonly GenreSummary[]; readonly rows: readonly Row[] }

describe.each(['before'])('p70a %s.json', (name) => {
  const doc = JSON.parse(read(`${name}.json`)) as Doc;

  // Flap: existující sady mají jen 4 věty, které rychlá hra do flap opravdu pošle (štítky P68 + P68R/P68T/P54C/P66).
  const SHORT: Readonly<Record<string, number>> = { flap: 4 };

  it('measures every playable genre with 5 sentences x 10 seeds', () => {
    expect(doc.seeds).toBe(SEEDS);
    expect(doc.summary.map((row) => row.genre)).toEqual(playableGenres());
    for (const row of doc.summary) {
      const sentences = SHORT[row.genre] ?? SENTENCES_PER_GENRE;
      expect(row.sentences, row.genre).toBe(sentences);
      expect(row.runs, row.genre).toBe(sentences * SEEDS);
    }
  });

  it('summary and table are recomputed from the raw rows', () => {
    const summary = summarize(doc.rows, playableGenres());
    expect(doc.summary).toEqual(summary);
    expect(read(`${name}.md`)).toContain(table(summary));
  });

  it('the winning bot wins at least as often as the beginner in every genre', () => {
    for (const row of doc.summary) expect(row.perfectWinRate ?? 0, row.genre).toBeGreaterThanOrEqual(row.winRate ?? 0);
  });
});
