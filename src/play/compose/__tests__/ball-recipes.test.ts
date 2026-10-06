import { beforeAll, describe, expect, it } from 'vitest';
import { arcadeWorldOf, specNeedsPhysics } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { ALLOWED, assemblyOfCell } from '../allowed';
import { compileRecipe } from '../compile';

describe('native ball production assembly', () => {
  beforeAll(async () => { await loadRapier(); });
  const cells = ALLOWED.filter(cell => cell.recipe.move === 'ball');
  it('registers both physical scoring combinations before scene activation', () => {
    expect(cells).toHaveLength(2);
    expect(cells.every(cell => cell.status === 'staged')).toBe(true);
  });
  it.each(cells.flatMap(cell => ['football field', 'basketball court', 'golf course'].map(setting => ({ cell, setting }))))('$cell.id in $setting has a physical score witness on seeds1–20', ({ cell, setting }) => {
    const assembly = assemblyOfCell(cell);
    const spec = compileRecipe({ ...assembly, content: { ...assembly.content, setting } });
    expect(specNeedsPhysics(spec)).toBe(true);
    for (let seed = 1; seed <= 20; seed++) {
      const made = arcadeWorldOf(spec, seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const verdict = verifyArcade(made.world, undefined, made.roleBindings);
      expect(verdict.failures, `${setting}/${seed}`).toEqual([]);
      expect(verdict.replayEqual).toBe(true);
      expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'score', run: 'winner', evidence: 'physical-ball-in-goal' }));
      expect(verdict.witnesses.some(w => w.verb === 'ball' && w.run === 'winner')).toBe(true);
      if (cell.recipe.threats.includes('rival')) {
        expect(verdict.witnesses).toContainEqual(expect.objectContaining({ verb: 'rival', run: 'probe', evidence: 'keeper-deflected-physical-ball', actor: expect.objectContaining({ label: 'walrus' }) }));
      }
    }
  }, 120_000);
});
