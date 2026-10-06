import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';

it('pins real ball recipe difficulty and exact replays on twenty paired seeds', async () => {
  await loadRapier();
  const rows = [];
  for (const cell of liveCells().filter(cell => cell.recipe.move === 'ball')) {
    const wins = { novice: 0, intermediate: 0, expert: 0 };
    for (let seed = 1; seed <= 20; seed++) {
      const made = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      for (const profile of ['novice', 'intermediate', 'expert'] as const) {
        const result = runBot(made.world, undefined, { planner: false, ...(profile === 'expert' ? {} : { profile }) });
        const replayEqual = replay(made.world, result.inputs, ARCADE_LIBRARY).hash === result.hash;
        wins[profile] += Number(result.outcome === 'won');
        rows.push({ cell: cell.id, seed, profile, won: result.outcome === 'won', tick: result.tick, hash: result.hash, replayEqual });
        expect(replayEqual).toBe(true);
      }
    }
    writeFileSync('evals/play/p41/ball-difficulty.json', JSON.stringify({ rows }, null, 2));
    expect(wins.novice, cell.id).toBeGreaterThanOrEqual(6);
    expect(wins.novice, cell.id).toBeLessThanOrEqual(14);
    expect(wins.intermediate, cell.id).toBeGreaterThanOrEqual(16);
    expect(wins.expert, cell.id).toBe(20);
  }
}, 180_000);
