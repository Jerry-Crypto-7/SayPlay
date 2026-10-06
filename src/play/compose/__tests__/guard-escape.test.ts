import { expect, it } from 'vitest';
import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
import { ALLOWED, assemblyOfCell } from '../allowed';
import { compileRecipe } from '../compile';

it('escaping with a key uses the proven stealth simulation and actual patrol evidence', () => {
  const stealth = ALLOWED.find(cell => cell.id === 'walk.collect+guard')!;
  const escape = ALLOWED.find(cell => cell.id === 'walk.escape+collect+guard')!;
  for (let seed = 1; seed <= 20; seed++) {
    const make = (cell: typeof escape) => {
      const result = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), seed);
      if (!result.ok) throw new Error(result.issues.join('; '));
      return result;
    };
    const previous = make(stealth), made = make(escape);
    // Same controls, geometry, timings and rule program as the calibrated cell.
    expect(made.world).toEqual(previous.world);
    if (seed > 5) continue;
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.publishEligible).toBe(true);
    expect(verdict.replayEqual).toBe(true);
    for (const verb of ['walk', 'collect', 'guard', 'escape']) expect(verdict.witnesses.some(witness => witness.verb === verb), verb).toBe(true);
  }
});
