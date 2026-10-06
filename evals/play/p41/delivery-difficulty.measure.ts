import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { runBot } from '@/play/arcade/verify';
import { ALLOWED, assemblyOfCell } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';

it('measures physical delivery and paired profile replays before promotion', () => {
  const cell = ALLOWED.find(cell => cell.id === 'drive.reach+deliver')!;
  const wins = { novice: 0, intermediate: 0, expert: 0 };
  const rows = [];
  for (let seed = 1; seed <= 20; seed++) {
    const made = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    for (const profile of ['novice', 'intermediate', 'expert'] as const) {
      const run = runBot(made.world, undefined, { roleBindings: made.roleBindings, ...(profile === 'expert' ? {} : { profile }) });
      const replayEqual = replay(made.world, run.inputs, ARCADE_LIBRARY).hash === run.hash;
      wins[profile] += Number(run.outcome === 'won');
      const delivered = run.witnesses.some(witness => witness.verb === 'deliver');
      rows.push({ seed, profile, won: run.outcome === 'won', delivered, hash: run.hash, replayEqual });
      expect(replayEqual).toBe(true);
      if (run.outcome === 'won') expect(delivered).toBe(true);
    }
  }
  writeFileSync('evals/play/p41/delivery-difficulty.json', JSON.stringify({ wins, rows }, null, 2));
  expect(wins.novice).toBeGreaterThanOrEqual(6);
  expect(wins.novice).toBeLessThanOrEqual(14);
  expect(wins.intermediate).toBeGreaterThanOrEqual(16);
  expect(wins.expert).toBe(20);
});
