/**
 * P64 T8-R6: brána G3 přepočítaná z běhů v `ttp-r6.json`, ne opsaná ze souhrnu. Medián P64 na Pixelu 7 (CPU 4×) smí být
 * nejvýš o 200 ms horší než `main`; README „T8-R6“ musí nést tatáž čísla. Spadlý běh, chybějící strana nebo souhrn, který
 * neodpovídá bězím, test shodí.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const DIR = join(process.cwd(), 'evals', 'play', 'p64');

interface Run { readonly profile: string; readonly side: 'A' | 'B'; readonly playable: boolean; readonly ms: number }
interface Side { readonly n: number; readonly failed: number; readonly median: number }
interface Row { readonly profile: string; readonly A: Side; readonly B: Side; readonly diffMedian: number }

const ttp = JSON.parse(readFileSync(join(DIR, 'ttp-r6.json'), 'utf8')) as {
  readonly runs: number;
  readonly a: { readonly label: string };
  readonly b: { readonly label: string };
  readonly results: readonly Run[];
  readonly summary: { readonly byProfile: readonly Row[] };
};
const readme = readFileSync(join(DIR, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const section = readme.slice(readme.indexOf('## T8-R6: G3 – přeměření'));

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sideMs = (profile: string, side: 'A' | 'B'): number[] =>
  ttp.results.filter((r) => r.profile === profile && r.side === side && r.playable).map((r) => r.ms);

describe('P64 T8-R6 G3 time to playable', () => {
  it('measures main against the branch with at least 5 runs and no failure', () => {
    expect(ttp.a.label).toContain('main');
    expect(ttp.b.label).toContain('P64');
    expect(ttp.runs).toBeGreaterThanOrEqual(5);
    expect(ttp.results.every((r) => r.playable)).toBe(true);
  });

  it('recomputes the phone medians from the runs and passes the +200 ms gate', () => {
    const a = median(sideMs('pixel7-cpu4', 'A'));
    const b = median(sideMs('pixel7-cpu4', 'B'));
    const row = ttp.summary.byProfile.find((r) => r.profile === 'pixel7-cpu4');
    expect(row?.A.median).toBe(a);
    expect(row?.B.median).toBe(b);
    expect(row?.diffMedian).toBe(b - a);
    expect(b - a).toBeLessThanOrEqual(200);
  });

  it('README carries the same phone numbers and verdict', () => {
    const a = median(sideMs('pixel7-cpu4', 'A'));
    const b = median(sideMs('pixel7-cpu4', 'B'));
    const line = section.split('\n').find((l) => l.startsWith('| Pixel 7')) ?? '';
    expect(line).toContain(`| ${a} ms | ${b} ms | ${b - a < 0 ? '−' : '+'}${Math.abs(b - a)} ms |`);
    expect(line).toContain('**splněna**');
  });
});
