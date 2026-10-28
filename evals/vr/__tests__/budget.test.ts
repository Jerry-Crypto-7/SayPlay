/**
 * Rozpočet snímku Questu 2 (P65 T6) přepočítaný z měření: `evals/vr/budget.json` zapisuje `evals/vr/budget.mjs`
 * (všech 19 žánrů v emulátoru IWER). Nejhorší snímek každého žánru se spočte znovu ze vzorků, ne z čísla, které
 * soubor nebo README o sobě tvrdí, a porovná s `QUEST2_BUDGET`. Žánr nad rozpočtem test shodí; srazit se má
 * v profilu XR (`src/play/xr/quality.ts`, `XrCull` v `XrRig.tsx`) a změřit znovu.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { QUEST2_BUDGET } from '@/play/xr/quality';

interface Sample {
  readonly tick: number;
  readonly calls: number;
  readonly triangles: number;
  readonly textureMB: number;
  readonly presenting: boolean;
  readonly eyes: number;
}
interface Genre {
  readonly id: string;
  readonly kind: 'native' | 'diorama';
  readonly samples: readonly Sample[];
  readonly max: { readonly calls: number; readonly triangles: number; readonly textureMB: number };
}
interface Report {
  readonly budget: { readonly calls: number; readonly triangles: number };
  readonly ticks: number;
  readonly every: number;
  readonly genres: readonly Genre[];
}

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const report = JSON.parse(read('../budget.json')) as Report;

/** Nejhorší snímek žánru ze vzorků. */
const peakOf = (genre: Genre) => ({
  calls: Math.max(...genre.samples.map((sample) => sample.calls)),
  triangles: Math.max(...genre.samples.map((sample) => sample.triangles)),
  textureMB: Math.max(...genre.samples.map((sample) => sample.textureMB)),
});

/** Žánry nad rozpočtem, přepočtené ze vzorků. */
function overBudget(genres: readonly Genre[], budget: { readonly calls: number; readonly triangles: number }): string[] {
  return genres.flatMap((genre) => {
    const peak = peakOf(genre);
    return peak.calls > budget.calls || peak.triangles > budget.triangles ? [`${genre.id}: ${String(peak.calls)} calls, ${String(peak.triangles)} triangles`] : [];
  });
}

describe('Quest 2 frame budget per genre (evals/vr/budget.json)', () => {
  it('measures all 19 genres – 4 played by hand, 15 on the desk – in a two-eye VR session', () => {
    const ids = report.genres.map((genre) => genre.id);
    expect(new Set(ids).size).toBe(19);
    expect(new Set(ids.map((id) => id.split('.')[0])).size).toBe(19);
    expect(report.genres.filter((genre) => genre.kind === 'native').map((genre) => genre.id.split('.')[0]).sort()).toEqual(['shooter', 'slice', 'throw', 'whack']);
    expect(report.genres.filter((genre) => genre.kind === 'diorama')).toHaveLength(15);
    for (const genre of report.genres) {
      expect(genre.samples.length, genre.id).toBeGreaterThan(1);
      expect(genre.samples.every((sample) => sample.presenting && sample.eyes === 2), genre.id).toBe(true);
    }
  });

  it('was measured against the current budget', () => {
    expect(report.budget).toEqual(QUEST2_BUDGET);
  });

  it('keeps the summary of each genre equal to its worst sample', () => {
    for (const genre of report.genres) expect(genre.max, genre.id).toEqual(peakOf(genre));
  });

  it('keeps every genre within the budget', () => {
    expect(overBudget(report.genres, QUEST2_BUDGET)).toEqual([]);
  });

  it('flags a genre whose worst frame goes over the budget', () => {
    const [first, ...rest] = report.genres;
    const spiked = { ...first!, samples: [...first!.samples, { ...first!.samples[0]!, calls: QUEST2_BUDGET.calls + 1 }] };
    expect(overBudget([spiked, ...rest], QUEST2_BUDGET)).toEqual([expect.stringContaining(first!.id)]);
    const heavy = { ...first!, samples: [...first!.samples, { ...first!.samples[0]!, triangles: QUEST2_BUDGET.triangles + 1 }] };
    expect(overBudget([heavy], QUEST2_BUDGET)).toHaveLength(1);
  });

  it('shows the measured numbers in evals/vr/README.md, not numbers typed by hand', () => {
    const rows = new Map(
      [...read('../README.md').matchAll(/^\| `([^`]+)` \| (native|diorama) \| (\d+) \| (\d+) \| ([\d.]+) \|/gm)].map((match) => [
        match[1],
        { kind: match[2], calls: Number(match[3]), triangles: Number(match[4]), textureMB: Number(match[5]) },
      ]),
    );
    expect(rows.size).toBe(report.genres.length);
    for (const genre of report.genres) expect(rows.get(genre.id), genre.id).toEqual({ kind: genre.kind, ...peakOf(genre) });
  });
});
