/**
 * P58E T4: číslo v `result.json` a v README musí stát na řádcích měření. Test přepočítá bránu z řádků (cíl hraje žánr
 * věty, past nehraje lákavý žánr – pravidlo P58B T8) proti prahům plánu, ne proti prahům zapsaným ve výsledku, a ověří,
 * že výsledek i README hlásí verdikt, který z řádků vychází.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { P58B_HOLDOUT_SHA256 } from '../../p58b/seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p58e');
/** Prahy plánu P58E (Goal): ≥ 48/60 cílů, ≥ 18/20 pastí. */
const PLAN_GATES = { targetGenre: 48, trapOffLure: 18 };

interface Bot { readonly wins: boolean; readonly idleLoses: boolean; readonly replayEqual: boolean }
interface Row {
  readonly id: string; readonly family: 'target' | 'trap'; readonly genre: string | null; readonly lure: string | null;
  readonly quick: string | null; readonly read: string | null; readonly chained: boolean; readonly chainWithReading: 'chain' | 'single' | null;
  readonly step: boolean; readonly played: string | null;
  readonly specGenre: { readonly quick: string | null; readonly read: string | null }; readonly bot: Bot | null;
}
interface Count { readonly hit: number; readonly of: number }
interface Result {
  readonly sha256: string; readonly gates: typeof PLAN_GATES; readonly met: Record<string, boolean>;
  readonly summary: Record<string, Count> & { readonly chainReads: number; readonly chainSteps: number }; readonly rows: readonly Row[];
}

const result = JSON.parse(readFileSync(join(DIR, 'result.json'), 'utf8')) as Result;
const holdout = (JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', 'p58b', 'holdout.json'), 'utf8')) as { sentences: { id: string; family: string; genre: string | null; lure: string | null }[] }).sentences;
const genreOf = (value: string | null): string | null => (value === null ? null : value.split('.')[0]!);
const ok = (row: Row): boolean => (row.family === 'target' ? genreOf(row.played) === genreOf(row.genre) : row.played !== row.lure);
const count = (rows: readonly Row[], hit: (row: Row) => boolean): Count => ({ hit: rows.filter(hit).length, of: rows.length });

describe('P58E T4 – the game played from the reading on the sealed P58B set, chains included', () => {
  it('has one row per sealed sentence with its label', () => {
    expect(result.sha256).toBe(P58B_HOLDOUT_SHA256);
    expect(result.rows.map((row) => [row.id, row.family, row.genre, row.lure])).toEqual(holdout.map((s) => [s.id, s.family, s.genre, s.lure]));
  });

  it('plays the reading game of a chain only where the reading says one game, else as P58D', () => {
    for (const row of result.rows) {
      expect(row.played, row.id).toBe(row.step ? row.read : row.chained ? 'chain' : row.quick);
      // Řetěz: hra ze čtení jen tam, kde se čtením `chainOrSingle` řekne jedna hra. Jedna hra: jen jiný žánr než rychlá.
      if (row.step && row.chained) expect(row.chainWithReading, row.id).toBe('single');
      if (row.step && !row.chained) expect(row.specGenre.read !== null && row.specGenre.read !== row.specGenre.quick, row.id).toBe(true);
      if (row.chained && row.chainWithReading === 'chain') expect(row.step, row.id).toBe(false);
      expect(row.bot === null, row.id).toBe(row.played === 'chain');
    }
    expect(result.summary.chainReads).toBe(result.rows.filter((row) => row.chained).length);
    expect(result.summary.chainSteps).toBe(result.rows.filter((row) => row.chained && row.step).length);
  });

  it('recomputes the gate from the rows against the plan thresholds', () => {
    const targets = result.rows.filter((row) => row.family === 'target');
    const traps = result.rows.filter((row) => row.family === 'trap');
    const games = result.rows.filter((row) => row.bot !== null);
    const recomputed = {
      targetGenre: count(targets, ok),
      trapOffLure: count(traps, ok),
      bot: count(games, (row) => row.bot!.wins),
      idleLoses: count(games, (row) => row.bot!.idleLoses),
      replayEqual: count(games, (row) => row.bot!.replayEqual),
    };
    expect([targets.length, traps.length]).toEqual([60, 20]);
    for (const [key, value] of Object.entries(recomputed)) expect(result.summary[key], key).toEqual(value);
    expect(result.gates).toEqual(PLAN_GATES);
    expect(result.met).toEqual({
      targetGenre: recomputed.targetGenre.hit >= PLAN_GATES.targetGenre,
      trapOffLure: recomputed.trapOffLure.hit >= PLAN_GATES.trapOffLure,
      bot: recomputed.bot.hit === recomputed.bot.of,
      idleLoses: recomputed.idleLoses.hit === recomputed.idleLoses.of,
      replayEqual: recomputed.replayEqual.hit === recomputed.replayEqual.of,
    });
  });

  it('states the recomputed verdict in the README', () => {
    const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
    const { targetGenre, trapOffLure } = result.summary;
    expect(readme).toContain(`${targetGenre.hit}/60`);
    expect(readme).toContain(`${trapOffLure.hit}/20`);
    expect(readme).toContain(result.met.targetGenre && result.met.trapOffLure ? 'Brána splněna' : 'Brána nesplněna');
  });
});
