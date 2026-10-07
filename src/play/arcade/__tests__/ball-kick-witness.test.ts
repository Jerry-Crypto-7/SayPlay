import { beforeAll, expect, it } from 'vitest';
import { nativeSpec } from '../../compose/native';
import { arcadeWorldOf } from '../compile';
import { loadRapier } from '../physics/world';
import { verifyArcade } from '../verify';
import { matchesWitness } from '../witness';

beforeAll(loadRapier);

it.each([
  ['football', 'goal', true],
  ['basketball', 'hoop', false],
  ['golf ball', 'hole', false],
] as const)('%s only certifies kick for an actual goal shot', (ball, target, kick) => {
  const spec = nativeSpec({ move: 'ball', objective: 'score', actions: [], threats: [] }, {
    genre: 'throw', mode: 'default', hero: 'bear', setting: 'stadium',
    cast: [{ label: ball, does: 'scenery' }, { label: target, does: 'throw_at' }],
  });
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  const result = verifyArcade(made.world, undefined, made.roleBindings);
  expect(result.publishEligible).toBe(true);
  expect(result.witnesses.some(w => matchesWitness({ actor: 'bear', verb: 'kick', object: 'ball' }, w))).toBe(kick);
  for (const witness of result.witnesses.filter(w => w.verb === 'kick')) {
    expect(witness.run).toBe('winner');
    expect(witness.evidence).toBe('physical-ball-kicked-into-goal');
    expect(witness.tick).toBeGreaterThan(0);
  }
}, 120000);
