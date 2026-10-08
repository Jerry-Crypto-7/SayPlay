import { beforeAll, expect, it } from 'vitest';
import { loadRapier } from '../../arcade/physics/world';
import { compose } from '../compose';
import { extractIntent } from '../../intent/extract';
import { matchesWitness } from '../../arcade/witness';
import { arcadeWorldOf } from '../../arcade/compile';
import { readGameSpec } from '../../spec';

beforeAll(async () => { await loadRapier(); });
const examples = [
  'a monster truck racing other trucks and firing missiles',
  'a seal swimming under the ice, catching fish and avoiding orcas',
  'a goat jumping up a mountain while rocks fall',
  'a samurai duels a bear and then escapes the burning village',
];
it.each(examples)('%s composes and proves the full sentence on five seeds', sentence => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const intent = extractIntent(sentence), made = compose(intent, seed);
    expect(readGameSpec(made.spec)).toMatchObject({ ok: true });
    expect(made.unmet, JSON.stringify({ seed, intent, issues: made.issues })).toEqual([]);
    expect(arcadeWorldOf(made.spec, seed).ok).toBe(true);
    for (const item of intent.items.filter(item => item.essential)) expect(made.witnesses.some(witness => matchesWitness(item, witness)), JSON.stringify(item)).toBe(true);
  }
}, 120000);
