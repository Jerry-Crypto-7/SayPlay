import { expect, it } from 'vitest';
import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
import { matchesWitness } from '../../arcade/witness';
import { FLAG, BODY, HEADER, ROLE, bodyBase } from '../../arcade/contract';
import { ALLOWED, assemblyOfCell } from '../allowed';
import { compileRecipe } from '../compile';

const make = (seed: number) => {
  const cell = ALLOWED.find(cell => cell.id === 'drive.reach+shoot+collect')!;
  const spec = compileRecipe(assemblyOfCell(cell, { ...cell.preset!, hero: 'robot', cast: [{ label: 'crystal', does: 'collect' }, { label: 'space bug', does: 'shoot_at' }] }));
  const result = arcadeWorldOf(spec, seed);
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result;
};

it('driving, shooting and collecting each occur during the same winning run', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const made = make(seed);
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.publishEligible).toBe(true);
    expect(verdict.replayEqual).toBe(true);
    for (const verb of ['drive', 'shoot', 'collect']) expect(verdict.witnesses.some(w => w.verb === verb && w.run === 'winner'), verb).toBe(true);
    expect(verdict.witnesses.some(w => matchesWitness({ actor: 'robot', verb: 'collect', object: 'crystal' }, w))).toBe(true);
    expect(verdict.witnesses.some(w => matchesWitness({ actor: 'robot', verb: 'collect', object: 'coin' }, w))).toBe(false);
  }
});

it('a collectible label without its actual pickup body cannot prove collection', () => {
  const made = make(1), initial = [...made.world.initial];
  for (let body = 0; body < initial[HEADER.bodyCount]!; body++) if (initial[bodyBase(body) + BODY.role] === ROLE.collectible) initial[bodyBase(body) + BODY.flags]! &= ~FLAG.alive;
  const verdict = verifyArcade({ ...made.world, initial }, undefined, made.roleBindings);
  expect(verdict.witnesses.some(w => w.verb === 'collect')).toBe(false);
});
