import { beforeAll, expect, it } from 'vitest';
import { loadRapier } from '../../arcade/physics/world';
import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
import { matchesWitness } from '../../arcade/witness';
import { extractIntent } from '../../intent/extract';
import { compose } from '../compose';
import { ALLOWED, assemblyOfCell } from '../allowed';
import { compileRecipe } from '../compile';
import { compileWith, GENRE_MODULES } from '../../genre';
import type { GenreModule } from '../../genre/contract';

beforeAll(loadRapier);
it('the gravity-and-thrust lander is airborne movement and preserves the actual landing target', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const made = compose(extractIntent('land a helicopter on a ship'), seed);
    expect(made.recipe).toMatchObject({ move: 'glide', objective: 'land' });
    expect(made.recipe.move).toBe('glide');
    expect(made.witnesses.some(w => matchesWitness({ actor: 'helicopter', verb: 'land', object: 'ship' }, w))).toBe(true);
    expect(made.witnesses.some(w => w.verb === 'glide')).toBe(true);
    expect(made.witnesses.some(w => w.verb === 'drive')).toBe(false);
  }
});
it('a lander with attached parts still flies, not drives', () => {
  const made = compose(extractIntent('a spaceship flies and lands on the moon while rocks fall'), 1);
  expect(made.recipe).toMatchObject({ move: 'glide', objective: 'land' });
  expect(made.recipe.parts?.length).toBeGreaterThan(0);
  expect(made.witnesses.some(w => w.verb === 'glide')).toBe(true);
  expect(made.witnesses.some(w => w.verb === 'drive')).toBe(false);
});
it('correcting the recipe movement leaves the legacy landing simulation unchanged', () => {
  const cell = ALLOWED.find(cell => cell.id === 'voyage.land')!;
  const assembly = assemblyOfCell(cell);
  if (assembly.content.genre !== 'voyage') throw new Error('expected voyage content');
  for (const seed of [1, 2, 3, 4, 5]) {
    const actual = arcadeWorldOf(compileRecipe(assembly), seed);
    const original = arcadeWorldOf(compileWith(GENRE_MODULES.voyage as GenreModule, assembly.content), seed);
    if (!actual.ok || !original.ok) throw new Error('landing build failed');
    expect(actual.world).toEqual(original.world);
    expect(verifyArcade(actual.world, undefined, actual.roleBindings).publishEligible).toBe(true);
  }
});
