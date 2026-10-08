import { beforeAll, expect, it } from 'vitest';
import { loadRapier } from '../../arcade/physics/world';
import { matchesWitness } from '../../arcade/witness';
import { extractIntent } from '../../intent/extract';
import { compose } from '../compose';
import { arcadeWorldOf } from '../../arcade/compile';
import { FLAG, BODY, bodyBase } from '../../arcade/contract';
import { verifyArcade } from '../../arcade/verify';
import { readGameSpec } from '../../spec';
import { ALLOWED, assemblyOfCell } from '../allowed';
import { compileRecipe } from '../compile';

beforeAll(loadRapier);
it.each(['deliver pizzas on a bike', 'ride a bike around the city delivering pizza', 'pizza delivery by bike', 'use a bike to bring pizzas to hungry people', 'drive around the city without racing, just deliver pizzas', 'deliver mail to every house'])('selects actual delivery for %s', sentence => {
  const intent = extractIntent(sentence);
  const made = compose(intent, 1);
  expect(made.recipe.actions).toContain('deliver');
  for (const item of intent.items.filter(item => item.essential)) {
    expect(made.witnesses.some(witness => matchesWitness(item, witness)), JSON.stringify(item)).toBe(true);
  }
});

const specOf = () => {
  const cell = ALLOWED.find(cell => cell.id === 'drive.reach+deliver')!;
  return compileRecipe(assemblyOfCell(cell, { ...cell.preset!, cast: [{ label: 'pizza', does: 'reach' }] }));
};
it('physically picks up, carries and consumes the named cargo at the distant destination', () => {
  const spec = specOf();
  expect(readGameSpec(spec).ok).toBe(true);
  for (const seed of [1, 2, 3, 4, 5]) {
    const made = arcadeWorldOf(spec, seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(made.world.rules.some(rule => rule.id === 'finish')).toBe(false);
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.publishEligible, `${seed}: ${verdict.failures}`).toBe(true);
    expect(verdict.replayEqual).toBe(true);
    const pickup = verdict.witnesses.find(witness => witness.verb === 'collect' && witness.object?.label === 'pizza');
    const delivery = verdict.witnesses.find(witness => witness.verb === 'deliver' && witness.object?.label === 'pizza');
    expect(pickup).toBeDefined();
    expect(delivery?.tick).toBeGreaterThan(pickup!.tick + 60);
  }
});
it('reaching the finish without picking up cargo cannot win or prove delivery', () => {
  const spec = specOf();
  const made = arcadeWorldOf({ ...spec, rules: spec.rules!.filter(rule => rule.id !== 'p41_take') }, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  const verdict = verifyArcade(made.world, undefined, made.roleBindings);
  expect(verdict.bot.outcome).not.toBe('won');
  expect(verdict.witnesses.some(witness => witness.verb === 'deliver')).toBe(false);
});
it('removing the actual cargo body eliminates the delivery evidence', () => {
  const made = arcadeWorldOf(specOf(), 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  const cargo = made.roleBindings.find(binding => binding.roleId === 'cargo')!;
  const initial = [...made.world.initial];
  initial[bodyBase(cargo.body) + BODY.flags]! &= ~FLAG.alive;
  const verdict = verifyArcade({ ...made.world, initial }, undefined, made.roleBindings);
  expect(verdict.bot.outcome).not.toBe('won');
  expect(verdict.witnesses.some(witness => witness.verb === 'deliver')).toBe(false);
});
