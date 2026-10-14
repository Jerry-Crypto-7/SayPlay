import { beforeAll, describe, expect, it } from 'vitest';
import { loadRapier } from '@/play/arcade/physics/world';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { baseControlOf } from '@/play/arcade/addons';
import { verifyArcade } from '@/play/arcade/verify';
import { GENRES, GENRE_MODES } from '@/play/genre/contract';
import { MOVES } from '@/play/intent/contract';
import { ALLOWED, assemblyOfCell, liveCells } from '../allowed';
import { compileRecipe } from '../compile';
import { recipeSchema } from '../recipe';
import { stageOf } from '../stage-registry';

describe('allowed recipes', () => {
  beforeAll(async () => { await loadRapier(); });
  it('has thirty live combinations with two goals and an extra action or threat per movement', () => {
    expect(liveCells().length).toBeGreaterThanOrEqual(30);
    for (const move of MOVES) {
      const cells = liveCells().filter(cell => cell.recipe.move === move);
      expect(new Set(cells.map(cell => cell.recipe.objective)).size, move).toBeGreaterThanOrEqual(2);
      expect(cells.some(cell => cell.recipe.actions.length + cell.recipe.threats.length > 0), move).toBe(true);
    }
  });
  it('has a live assembly for every existing genre and mode', () => {
    for (const genre of GENRES) for (const mode of GENRE_MODES[genre]) {
      expect(liveCells().some(cell => cell.preset.genre === genre && cell.preset.mode === mode), `${genre}.${mode}`).toBe(true);
    }
  });
  it('rejects unknown pieces, duplicate actions and extra fields', () => {
    expect(recipeSchema.safeParse({ move: 'teleport', actions: [], objective: 'reach', threats: [] }).success).toBe(false);
    expect(recipeSchema.safeParse({ move: 'run', actions: ['shoot', 'shoot'], objective: 'reach', threats: [] }).success).toBe(false);
    expect(recipeSchema.safeParse({ move: 'run', actions: [], objective: 'reach', threats: [], code: 'anything' }).success).toBe(false);
  });

  it('explicit counts override tuned recipe defaults while explicit params keep precedence', () => {
    const cell = ALLOWED.find(cell => cell.id === 'arena.escape+collect')!;
    const content = { ...cell.preset!, params: undefined, counts: { enemy: 3, collectible: 12 } };
    const counted = compileRecipe(assemblyOfCell(cell, content));
    expect(counted.controlParams?.tuning).toMatchObject({ chasers: 3, items: 12 });
    const explicit = compileRecipe(assemblyOfCell(cell, { ...content, params: { items: 5 } }));
    expect(explicit.controlParams?.tuning).toMatchObject({ chasers: 3, items: 5 });
  });

  it('keeps staged cells out of selection', () => {
    expect(liveCells().length).toBeGreaterThan(0);
    expect(liveCells().every(cell => cell.status === 'live')).toBe(true);
    expect(new Set(ALLOWED.map(cell => cell.id)).size).toBe(ALLOWED.length);
    for (const cell of ALLOWED) expect(recipeSchema.safeParse(cell.recipe).success, cell.id).toBe(true);
    expect(stageOf('unimplemented')).toBeNull();
  });

  // run.escape may lose one of seeds 1–5: the runner bot's coin pace (P46B R1) costs it seed 4,
  // publish picks a won seed. Owner's decision, plans/P46B-useky-a-boss-2026-10-12.md R3 (b).
  const LOSSES_ALLOWED: Record<string, number> = { 'run.escape': 1 };
  for (const cell of ALLOWED.filter(cell => cell.preset !== null)) it(`${cell.id} plays every declared piece on seeds 1–5`, () => {
    const lost: number[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const spec = compileRecipe(assemblyOfCell(cell));
      const made = arcadeWorldOf(spec, seed);
      if (!made.ok) throw new Error(`${cell.id}: ${made.issues.join('; ')}`);
      const stage = stageOf(baseControlOf(made.world.control).id);
      if (cell.status === 'live') {
        expect(stage?.scene).toBeTruthy();
        expect(stage?.input).toBeTruthy();
      }
      const verdict = verifyArcade(made.world, undefined, made.roleBindings);
      expect(verdict.replayEqual).toBe(true);
      if (verdict.bot.outcome !== 'won') { lost.push(seed); continue; }
      const verbs = new Set(verdict.witnesses.map(w => w.verb));
      const pieces = [...cell.recipe.actions, cell.recipe.objective, ...cell.recipe.threats, ...(cell.recipe.move === 'stationary' ? [] : [cell.recipe.move])];
      for (const piece of pieces) expect(verbs.has(piece), `${cell.id}/${seed}: missing ${piece}; witnessed ${[...verbs]}`).toBe(true);
    }
    expect(lost.length, `${cell.id} lost seeds ${lost}`).toBeLessThanOrEqual(LOSSES_ALLOWED[cell.id] ?? 0);
  });
});
