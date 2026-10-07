import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BOT_PROFILES } from '../../arcade/verify';
import { assemblyOfCell, liveCells } from '../allowed';
import { compileRecipe } from '../compile';

it('pins measured novice and intermediate bounds for every current live recipe', () => {
  const report = JSON.parse(readFileSync('evals/play/p41/difficulty.json', 'utf8')) as {
    profiles: typeof BOT_PROFILES;
    seeds: number[];
    cells: string[];
    summary: Array<{ cell: string; specHash: string; profiles: Record<string, {
      runs: number; wins: number; winRate: number; errors: number; replayMismatches: number;
    }> }>;
  };
  const cells = liveCells();
  expect(report.profiles).toEqual(BOT_PROFILES);
  expect(report.seeds).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  expect(report.cells).toEqual(cells.map(cell => cell.id));
  expect(report.summary).toHaveLength(cells.length);
  for (const cell of cells) {
    const row = report.summary.find(row => row.cell === cell.id)!;
    expect(row, cell.id).toBeDefined();
    expect(row.specHash, `${cell.id}: stale measurement`).toBe(
      createHash('sha256').update(JSON.stringify(compileRecipe(assemblyOfCell(cell)))).digest('hex'),
    );
    for (const profile of ['novice', 'intermediate']) {
      const result = row.profiles[profile];
      expect(result.runs, cell.id).toBe(20);
      expect(result.errors, cell.id).toBe(0);
      expect(result.replayMismatches, cell.id).toBe(0);
      expect(result.winRate, cell.id).toBe(result.wins / 20);
      expect(result.winRate, `${cell.id}/${profile}`).toBeGreaterThanOrEqual(profile === 'novice' ? 0.3 : 0.8);
      expect(result.winRate, `${cell.id}/${profile}`).toBeLessThanOrEqual(profile === 'novice' ? 0.7 : 1);
    }
  }
});
