/**
 * Střídavé měření A/B (P50 T1). Zaměněné strany, špatně spočítaný medián nebo
 * selhaný běh započtený jako čas dají věrohodné číslo, které je špatně – a
 * podle něj se v P50 vrací nebo nechává každá změna.
 */

import { describe, expect, it } from 'vitest';

import { schedule, stats, summarize, type AbResult } from '../first-playable-ab.mjs';

const targets = [
  { kind: 'sentence' as const, key: 's1', sentence: 'one' },
  { kind: 'shared' as const, key: 'g1', sentence: 'two' },
];

describe('schedule', () => {
  it('pairs every target with one A and one B run back to back, alternating which side goes first', () => {
    const jobs = schedule({ targets, runs: 2, profiles: ['desktop', 'pixel7-cpu4'] });

    expect(jobs).toHaveLength(2 * 2 * 2 * 2);
    for (let index = 0; index < jobs.length; index += 2) {
      const [first, second] = [jobs[index], jobs[index + 1]];
      expect(first.pair).toBe(second.pair);
      expect([first.profile, first.target.key, first.run]).toEqual([second.profile, second.target.key, second.run]);
      expect(new Set([first.side, second.side])).toEqual(new Set(['A', 'B']));
      expect(first.side).toBe(first.pair % 2 === 0 ? 'A' : 'B');
    }
    expect(jobs.map((job) => job.side).join('')).toBe('ABBAABBAABBAABBA');
  });

  it('spreads the repeats over the whole run instead of measuring one target three times in a row', () => {
    const jobs = schedule({ targets, runs: 3, profiles: ['desktop'] });

    expect(jobs.map((job) => `${job.run}${job.target.key}`)).toEqual(['1s1', '1s1', '1g1', '1g1', '2s1', '2s1', '2g1', '2g1', '3s1', '3s1', '3g1', '3g1']);
  });
});

describe('stats', () => {
  it('takes the middle value of an odd count', () => {
    expect(stats([2300, 1900, 2100])).toEqual({ n: 3, median: 2100, min: 1900, max: 2300 });
  });

  it('averages the two middle values of an even count', () => {
    expect(stats([4000, 1000, 3000, 2000])).toEqual({ n: 4, median: 2500, min: 1000, max: 4000 });
  });

  it('has no median without a value', () => {
    expect(stats([])).toEqual({ n: 0, median: null, min: null, max: null });
  });
});

const run = (side: 'A' | 'B', pair: number, ms: number | null, key = 's1', profile = 'desktop'): AbResult => ({
  profile,
  kind: 'sentence',
  target: key,
  side,
  run: 1,
  pair,
  playable: ms !== null,
  ms,
  note: ms === null ? 'timeout' : null,
  har: null,
});

describe('summarize', () => {
  it('reports B minus A on the medians and on the per-pair differences', () => {
    const summary = summarize([run('A', 0, 2000), run('B', 0, 1800), run('B', 1, 1900), run('A', 1, 2200), run('A', 2, 2100), run('B', 2, 1700)]);
    const [row] = summary.byTarget;

    expect(row.A).toEqual({ n: 3, failed: 0, median: 2100, min: 2000, max: 2200 });
    expect(row.B).toEqual({ n: 3, failed: 0, median: 1800, min: 1700, max: 1900 });
    expect(row.diffMedian).toBe(-300);
    // Páry: −200, −300, −400.
    expect(row.pairedDiffMedian).toBe(-300);
    expect(summary.byKind).toEqual([{ profile: 'desktop', kind: 'sentence', A: row.A, B: row.B, diffMedian: -300, pairedDiffMedian: -300 }]);
  });

  it('counts a run that never became playable as a failure, not as a time', () => {
    const summary = summarize([run('A', 0, 2000), run('B', 0, null), run('B', 1, 1500), run('A', 1, 2400)]);
    const [row] = summary.byTarget;

    expect(row.B).toEqual({ n: 1, failed: 1, median: 1500, min: 1500, max: 1500 });
    expect(row.A).toEqual({ n: 2, failed: 0, median: 2200, min: 2000, max: 2400 });
    expect(row.diffMedian).toBe(-700);
    // Pár 0 má selhaný B – do párového rozdílu nepatří.
    expect(row.pairedDiffMedian).toBe(-900);
  });

  it('keeps profiles and targets apart and pools targets of a kind per profile', () => {
    const summary = summarize([
      run('A', 0, 1000, 's1'),
      run('B', 0, 1100, 's1'),
      run('A', 1, 3000, 's2'),
      run('B', 1, 3300, 's2'),
      run('A', 2, 5000, 's1', 'pixel7-cpu4'),
      run('B', 2, 4000, 's1', 'pixel7-cpu4'),
    ]);

    expect(summary.byTarget.map((row) => [row.profile, row.target, row.diffMedian])).toEqual([
      ['desktop', 's1', 100],
      ['desktop', 's2', 300],
      ['pixel7-cpu4', 's1', -1000],
    ]);
    const desktop = summary.byKind.find((row) => row.profile === 'desktop');
    expect(desktop?.A).toEqual({ n: 2, failed: 0, median: 2000, min: 1000, max: 3000 });
    expect(desktop?.pairedDiffMedian).toBe(200);
    expect(summary.byProfile.map((row) => [row.profile, row.pairedDiffMedian])).toEqual([
      ['desktop', 200],
      ['pixel7-cpu4', -1000],
    ]);
  });

  it('summarizes the first-frame time instead of time to playable when asked, missing values as failures', () => {
    const results = [
      { ...run('A', 0, 2000), firstFrameMs: 900 },
      { ...run('B', 0, 2100), firstFrameMs: 700 },
      { ...run('B', 1, 2050), firstFrameMs: null },
      { ...run('A', 1, 1900), firstFrameMs: 950 },
    ];
    const [row] = summarize(results, 'firstFrameMs').byTarget;

    expect(row.A).toEqual({ n: 2, failed: 0, median: 925, min: 900, max: 950 });
    expect(row.B).toEqual({ n: 1, failed: 1, median: 700, min: 700, max: 700 });
    expect(row.pairedDiffMedian).toBe(-200);
    expect(summarize(results).byTarget[0].pairedDiffMedian).toBe(125);
  });

  it('has no difference when one side never played', () => {
    const [row] = summarize([run('A', 0, 2000), run('B', 0, null)]).byTarget;

    expect(row.diffMedian).toBeNull();
    expect(row.pairedDiffMedian).toBeNull();
  });
});
