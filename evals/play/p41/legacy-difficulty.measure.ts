import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { runBot } from '@/play/arcade/verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { LEGACY_DIFFICULTY } from '@/play/compose/legacy-difficulty';

it('measures every opt-in legacy recipe across twenty seeds and unchanged profiles', () => {
  const profiles = ['expert', 'novice', 'intermediate'] as const;
  const rows: { cell: string; seed: number; profile: typeof profiles[number]; won: boolean; replayEqual: boolean }[] = [];
  for (const cellId of Object.keys(LEGACY_DIFFICULTY)) {
    const cell = liveCells().find(value => value.id === cellId)!;
    for (let seed = 1; seed <= 20; seed++) {
      const made = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), seed);
      if (!made.ok) throw new Error(`${cellId}/${seed}: ${made.issues.join('; ')}`);
      for (const profile of profiles) {
        const run = runBot(made.world, undefined, profile === 'expert' ? {} : { profile });
        rows.push({ cell: cellId, seed, profile, won: run.outcome === 'won', replayEqual: replay(made.world, run.inputs, ARCADE_LIBRARY).hash === run.hash });
      }
    }
  }
  writeFileSync('evals/play/p41/legacy-difficulty.json', JSON.stringify({ rows }, null, 2));
  expect(rows.every(row => row.replayEqual)).toBe(true);
  for (const cell of Object.keys(LEGACY_DIFFICULTY)) {
    const wins = (profile: typeof profiles[number]) => rows.filter(row => row.cell === cell && row.profile === profile && row.won).length;
    expect(wins('expert'), cell).toBe(20);
    expect(wins('intermediate'), cell).toBeGreaterThanOrEqual(16);
    expect(wins('novice'), cell).toBeGreaterThanOrEqual(6);
    expect(wins('novice'), cell).toBeLessThanOrEqual(14);
  }
});
