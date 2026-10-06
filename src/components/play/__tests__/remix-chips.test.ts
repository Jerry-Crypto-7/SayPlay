import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { verifyArcade } from '@/play/arcade/verify';
import { matchesWitness } from '@/play/arcade/witness';
import { liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { presetOf } from '@/play/compose/presets';
import { verifiedRecipeRemixes, applyRemix } from '@/play/director/remix';
import { extractIntent } from '@/play/intent/extract';
import { essentialTriples } from '@/play/intent/contract';
import { RecipeRemixChips } from '../RemixBox';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));
const parent = () => compileRecipe(presetOf({ genre: 'runner', mode: 'default', hero: 'fox', setting: 'forest' }));

describe('recipe remix chips', () => {
  it('offers two or three live, won, witnessed alternatives and applies exactly the verified spec', async () => {
    const source = parent();
    const chips = await verifiedRecipeRemixes(source, 1, { intent: extractIntent('A fox runs') });
    expect(chips.length).toBeGreaterThanOrEqual(2);
    expect(chips.length).toBeLessThanOrEqual(3);
    expect(chips.map(chip => chip.label)).toContain('Add shooting');
    for (const chip of chips) {
      const cell = liveCells().find(cell => cell.id === chip.cellId);
      expect(cell).toBeDefined();
      const world = arcadeWorldOf(chip.spec, 1);
      expect(world.ok).toBe(true);
      if (!world.ok) throw new Error('No world');
      const verdict = verifyArcade(world.world, undefined, world.roleBindings);
      expect(verdict.publishEligible).toBe(true);
      for (const verb of [...cell!.recipe.actions, ...cell!.recipe.threats]) expect(verdict.witnesses.some(witness => witness.verb === verb), `${chip.label}/${verb}`).toBe(true);
      expect(applyRemix(source, chip.ops)).toEqual({ ok: true, spec: chip.spec });
    }
  });

  it('preserves a named shooting action instead of reducing a remix to movement', async () => {
    const source = compileRecipe(presetOf({ genre: 'runner', mode: 'default', hero: 'fox', setting: 'forest', cast: [{ label: 'robot', does: 'shoot_at' }] }));
    const intent = extractIntent('A fox runs and shoots robots');
    const chips = await verifiedRecipeRemixes(source, 1, { intent });
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.some(chip => chip.id === 'add-shooting')).toBe(false);
    for (const chip of chips) {
      const made = arcadeWorldOf(chip.spec, 1);
      if (!made.ok) throw new Error('No world');
      const witnesses = verifyArcade(made.world, undefined, made.roleBindings).witnesses;
      for (const triple of essentialTriples(intent).filter(triple => triple.verb === 'shoot')) {
        const retained = chip.id === 'swap-boat' ? { ...triple, actor: 'boat' } : triple;
        expect(witnesses.some(witness => matchesWitness(retained, witness))).toBe(true);
      }
    }
  });

  it('does not advertise unmet requests or unproved original actions', async () => {
    expect(await verifiedRecipeRemixes(parent(), 1, { unmet: [{ actor: 'fox', verb: 'sing', object: null }] })).toEqual([]);
    expect(await verifiedRecipeRemixes(parent(), 1, { intent: extractIntent('A fox runs and sings') })).toEqual([]);
  });

  it('renders only server-verified chip summaries, with actual submit labels', () => {
    const chips = [{ id: 'add-shooting', label: 'Add shooting', cellId: 'runner.default+shoot_at' }];
    const html = renderToStaticMarkup(createElement(RecipeRemixChips, { chips, submit: () => undefined, disabled: false }));
    expect(html).toContain('Add shooting');
    expect(html).toContain('data-testid="recipe-remix-chip"');
    expect(html).not.toContain('Make it a race');
    expect(renderToStaticMarkup(createElement(RecipeRemixChips, { chips: [], submit: () => undefined, disabled: false }))).toBe('');
  });
});
