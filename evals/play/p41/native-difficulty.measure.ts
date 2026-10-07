import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { loadRapier } from '@/play/arcade/physics/world';
import { BOT_PROFILES, runBot, type BotProfile } from '@/play/arcade/verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';

interface Run {
  cell: string;
  seed: number;
  profile: BotProfile;
  won: boolean;
  outcome: string;
  tick: number | null;
  hash: string | null;
  replayEqual: boolean;
  error: string | null;
}

it('measures twenty paired seeds for both human profiles in every live recipe', async () => {
  const seeds = Array.from({ length: 20 }, (_, index) => index + 1);
  const profiles = Object.keys(BOT_PROFILES) as BotProfile[];
  const cells = liveCells().filter(cell => ['glide','walk'].includes(cell.recipe.move));
  const rows: Run[] = [];
  for (const cell of cells) for (const seed of seeds) {
    try {
      const spec = compileRecipe(assemblyOfCell(cell));
      await preloadPhysics(spec, loadRapier);
      const made = arcadeWorldOf(spec, seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      for (const profile of profiles) {
        const run = runBot(made.world, undefined, { profile });
        rows.push({ cell: cell.id, seed, profile, won: run.outcome === 'won', outcome: run.outcome, tick: run.tick, hash: run.hash,
          replayEqual: replay(made.world, run.inputs, ARCADE_LIBRARY).hash === run.hash, error: null });
      }
    } catch (error) {
      for (const profile of profiles) if (!rows.some(row => row.cell === cell.id && row.seed === seed && row.profile === profile)) {
        rows.push({ cell: cell.id, seed, profile, won: false, outcome: 'build-or-run-error', tick: null, hash: null, replayEqual: false, error: String(error) });
      }
    }
  }
  const summary = cells.map(cell => ({ cell: cell.id, recipe: cell.recipe,
    profiles: Object.fromEntries(profiles.map(profile => {
      const runs = rows.filter(row => row.cell === cell.id && row.profile === profile);
      return [profile, { runs: runs.length, wins: runs.filter(run => run.won).length, winRate: runs.filter(run => run.won).length / seeds.length,
        errors: runs.filter(run => run.error !== null).length, replayMismatches: runs.filter(run => run.error === null && !run.replayEqual).length }];
    })),
  }));
  writeFileSync('evals/play/p41/native-difficulty.json', `${JSON.stringify({ version: 1, profiles: BOT_PROFILES, seeds, cells: cells.map(cell => cell.id), summary, rows }, null, 2)}\n`);
  for (const cell of summary) {
    expect(cell.profiles.novice.winRate, cell.cell).toBeGreaterThanOrEqual(0.3);
    expect(cell.profiles.novice.winRate, cell.cell).toBeLessThanOrEqual(0.7);
    expect(cell.profiles.intermediate.winRate, cell.cell).toBeGreaterThanOrEqual(0.95);
  }
  expect(rows).toHaveLength(cells.length * seeds.length * profiles.length);
  expect(rows.filter(row => row.error !== null || !row.replayEqual)).toEqual([]);
});
