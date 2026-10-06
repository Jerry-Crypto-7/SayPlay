import { describe, expect, it } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { verifyArcade } from '@/play/arcade/verify';
import { ALLOWED, assemblyOfCell } from '../allowed';
import { compileRecipe } from '../compile';

describe('native walker production assembly', () => {
  const cells = ALLOWED.filter(cell => cell.recipe.move === 'walk');
  it('registers all seven combinations with a verified scene', () => {
    expect(cells).toHaveLength(7);
    expect(cells.every(cell => cell.status === 'live')).toBe(true);
  });
  it.each(cells)('$id proves every declared action on seeds 1–20', cell => {
    for (let seed = 1; seed <= 20; seed++) {
      const spec = compileRecipe(assemblyOfCell(cell));
      expect(spec.control).toBe('walker');
      const made = arcadeWorldOf(spec, seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const verdict = verifyArcade(made.world, undefined, made.roleBindings);
      expect(verdict.failures, `${cell.id}/${seed}`).toEqual([]);
      expect(verdict.bot.outcome).toBe('won');
      expect(verdict.replayEqual).toBe(true);
      for (const verb of [cell.recipe.move, cell.recipe.objective, ...cell.recipe.actions, ...cell.recipe.threats]) {
        expect(verdict.witnesses.some(w => w.verb === verb), `${cell.id}/${seed}: missing ${verb}`).toBe(true);
      }
      if (cell.recipe.threats.includes('guard')) {
        expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'guard', run: 'probe', evidence: 'caught-in-patrol-sight' }));
      }
    }
  }, 120_000);
});
