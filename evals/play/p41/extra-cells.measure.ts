import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { runBot } from '@/play/arcade/verify';
import { ALLOWED, assemblyOfCell } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';

it('measures the staged collect/escape compositions on twenty paired seeds', () => {
  const rows = [], summary = [];
  for (const id of ['drive.reach+shoot+collect', 'walk.escape+collect+guard']) {
    const cell = ALLOWED.find(cell => cell.id === id)!;
    const wins = { novice: 0, intermediate: 0, expert: 0 };
    for (let seed = 1; seed <= 20; seed++) {
      const made = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      for (const profile of ['novice', 'intermediate', 'expert'] as const) {
        const run = runBot(made.world, undefined, { roleBindings: made.roleBindings, ...(profile === 'expert' ? {} : { profile }) });
        const replayEqual = replay(made.world, run.inputs, ARCADE_LIBRARY).hash === run.hash;
        wins[profile] += Number(run.outcome === 'won');
        rows.push({ cell: id, seed, profile, won: run.outcome === 'won', hash: run.hash, replayEqual });
        expect(replayEqual).toBe(true);
        if (profile === 'expert') for (const verb of cell.recipe.actions) expect(run.witnesses.some(w => w.verb === verb), `${id}/${seed}/${verb}`).toBe(true);
      }
    }
    summary.push({ cell: id, wins });
  }
  writeFileSync('evals/play/p41/extra-cells.json', JSON.stringify({ summary, rows }, null, 2));
  for (const { cell, wins } of summary) {
    expect(wins.novice, cell).toBeGreaterThanOrEqual(6);
    expect(wins.novice, cell).toBeLessThanOrEqual(14);
    expect(wins.intermediate, cell).toBeGreaterThanOrEqual(16);
    expect(wins.expert, cell).toBe(20);
  }
});
