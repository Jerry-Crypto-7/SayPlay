/**
 * Konečné měření P47A (T12): čísla cílů ve `final.json` jsou z holdoutu, ne
 * ze sady, na které se ladilo – číslo z dev sady nebo panelu by vypadalo jako
 * úspěch. Otisk zapsaný ve `final.json` = otisk `holdout.json` (LF bajty) =
 * zapečetěný otisk ze vzniku sady, změřené věty jsou přesně věty
 * `holdout.json` a hodnoty cílů jsou `summaryOf` nad těmi řádky.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type FinaleRow, P47A_GENRES, summaryOf } from '../finale';

const DIR = join(process.cwd(), 'evals', 'play', 'p47a');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** Sada, na které se konečné číslo měří, a její otisk ze vzniku (README, `sets.test.ts`). */
const MEASURED_SET = 'holdout.json';
const HOLDOUT_SHA256 = '7f62855dd8f45ad6ab1f050aea403ad76030b5c9163c6bedef643cdddbd9bd79';
const TARGETS = ['finaleShare', 'behavioursMedian', 'deadTimeMedianS', 'risingShare'] as const;

interface FinalRow { readonly id: string; readonly text: string; readonly a: FinaleRow; readonly b: FinaleRow }
interface Target { readonly a: number | null; readonly value: number | null }
const FINAL = JSON.parse(readLf(join(DIR, 'final.json'))) as {
  holdout: { sha256: string; openedAt: string };
  targets: Record<(typeof TARGETS)[number], Target>;
  targetsSixGenres: Record<(typeof TARGETS)[number], Target>;
  rows: { holdout: FinalRow[] };
};
const SET_BYTES = readLf(join(DIR, MEASURED_SET));

describe('P47A final measurement', () => {
  it('records the sealed holdout hash, equal to the LF bytes of holdout.json, and the open time', () => {
    const sha256 = createHash('sha256').update(SET_BYTES, 'utf8').digest('hex');
    expect(FINAL.holdout.sha256).toBe(sha256);
    expect(sha256).toBe(HOLDOUT_SHA256);
    expect(Number.isNaN(Date.parse(FINAL.holdout.openedAt))).toBe(false);
  });

  it('measured exactly the holdout sentences, in order', () => {
    const sentences = (JSON.parse(SET_BYTES) as { sentences: { id: string; text: string }[] }).sentences.map(({ id, text }) => ({ id, text }));
    expect(FINAL.rows.holdout.map(({ id, text }) => ({ id, text }))).toEqual(sentences);
  });

  it('target values of A and B are summaryOf over those holdout rows, whole set and six genres', () => {
    const six = (rows: readonly FinaleRow[]) => rows.filter((row) => (P47A_GENRES as readonly string[]).includes(row.genre));
    const a = summaryOf(FINAL.rows.holdout.map((row) => row.a));
    const b = summaryOf(FINAL.rows.holdout.map((row) => row.b));
    const aSix = summaryOf(six(FINAL.rows.holdout.map((row) => row.a)));
    const bSix = summaryOf(six(FINAL.rows.holdout.map((row) => row.b)));
    for (const key of TARGETS) {
      expect(FINAL.targets[key], key).toMatchObject({ a: a[key], value: b[key] });
      expect(FINAL.targetsSixGenres[key], key).toMatchObject({ a: aSix[key], value: bSix[key] });
    }
  });
});
