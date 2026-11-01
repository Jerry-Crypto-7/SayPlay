/**
 * Střídavé měření A/B (P50 T1). Zaměněné strany, špatně spočítaný medián nebo
 * selhaný běh započtený jako čas dají věrohodné číslo, které je špatně – a
 * podle něj se v P50 vrací nebo nechává každá změna.
 */

import { describe, expect, it } from 'vitest';

import { gate, schedule, stats, summarize, type AbResult } from '../first-playable-ab.mjs';

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

/**
 * Brána P68I T4: selhaný běh v mediánech chybí, takže medián zbytku vypadá
 * dobře – bránu musí shodit sám. Desktop: B 2000 a 2200 (medián 2100), páry
 * +100 a +100; telefon: páry +150 a +150.
 */
const pixel = (side: 'A' | 'B', pair: number, ms: number | null) => run(side, pair, ms, 's1', 'pixel7-cpu4');
const withinLimits = (): AbResult[] => [
  run('A', 0, 1900),
  run('B', 0, 2000),
  run('B', 1, 2200),
  run('A', 1, 2100),
  pixel('A', 2, 4000),
  pixel('B', 2, 4150),
  pixel('B', 3, 4300),
  pixel('A', 3, 4150),
];
const failing = (results: AbResult[]) => gate(results).checks.filter((check) => !check.pass).map((check) => `${check.name}:${check.profile}`);

describe('gate', () => {
  it('passes with no failure, the desktop median of B within 3000 ms and both paired differences within 200 ms', () => {
    const result = gate(withinLimits());

    expect(result.pass).toBe(true);
    expect(result.failedTotal).toBe(0);
    expect(result.checks).toEqual([
      { name: 'failedTotal', profile: null, value: 0, limit: 0, pass: true },
      { name: 'medianB', profile: 'desktop', value: 2100, limit: 3000, pass: true },
      { name: 'pairedDiffMedian', profile: 'desktop', value: 100, limit: 200, pass: true },
      { name: 'pairedDiffMedian', profile: 'pixel7-cpu4', value: 150, limit: 200, pass: true },
    ]);
  });

  it('a failed run fails the gate although the medians of the remaining runs stay within limits', () => {
    const result = gate([...withinLimits(), run('B', 4, null), pixel('A', 5, null)]);

    expect(result.pass).toBe(false);
    expect(result.failed).toEqual({ A: 1, B: 1 });
    expect(result.failedTotal).toBe(2);
    expect(failing([...withinLimits(), run('B', 4, null)])).toEqual(['failedTotal:null']);
  });

  it('a desktop median of B over 3000 ms fails the gate; exactly 3000 ms passes', () => {
    const slow = (b0: number, b1: number) => [run('A', 0, b0 - 100), run('B', 0, b0), run('B', 1, b1), run('A', 1, b1 - 100), ...withinLimits().slice(4)];

    expect(failing(slow(3000, 3100))).toEqual(['medianB:desktop']);
    expect(gate(slow(3000, 3100)).pass).toBe(false);
    expect(gate(slow(2900, 3100)).pass).toBe(true);
  });

  it('a paired difference over 200 ms fails the gate on either profile; exactly 200 ms passes', () => {
    const desktop = (delta: number) => [run('A', 0, 1800), run('B', 0, 1800 + delta), run('B', 1, 1900 + delta), run('A', 1, 1900), ...withinLimits().slice(4)];
    const phone = (delta: number) => [...withinLimits().slice(0, 4), pixel('A', 2, 4000), pixel('B', 2, 4000 + delta), pixel('B', 3, 4100 + delta), pixel('A', 3, 4100)];

    expect(failing(desktop(250))).toEqual(['pairedDiffMedian:desktop']);
    expect(failing(phone(250))).toEqual(['pairedDiffMedian:pixel7-cpu4']);
    expect(gate(desktop(200)).pass).toBe(true);
    expect(gate(phone(200)).pass).toBe(true);
  });

  it('a profile that was not measured fails the gate instead of passing on a missing number', () => {
    expect(failing(withinLimits().slice(0, 4))).toEqual(['pairedDiffMedian:pixel7-cpu4']);
    expect(gate([]).pass).toBe(false);
  });
});
