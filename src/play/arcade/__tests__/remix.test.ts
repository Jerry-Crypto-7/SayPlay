/**
 * Remix čipy na běžci (P25A T8): každý čip na fixtuře běžce dá spec, který
 * projde `verifyArcade`, a `harder` mění právě jeden parametr tratě.
 */

import { describe, expect, it } from 'vitest';

import { applyRemix, REMIX_CHIPS, remixPatch } from '../../director/remix';
import { readGameSpec, type GameSpecV1 } from '../../spec';
import fixture from '../__fixtures__/runner.json';
import { arcadeWorldOf } from '../compile';
import { verifyArcade } from '../verify';

const parent = (() => {
  const read = readGameSpec(fixture);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
})();

function publishable(spec: GameSpecV1): boolean {
  const built = arcadeWorldOf(spec, 1);
  return built.ok && verifyArcade(built.world).publishEligible;
}

function remix(chip: (typeof REMIX_CHIPS)[number], from: GameSpecV1, seed = 1): GameSpecV1 {
  const applied = applyRemix(from, remixPatch(chip, from, seed, publishable));
  if (!applied.ok) throw new Error(`${chip}: ${applied.detail}`);
  return applied.spec;
}

describe('runner remix chips', () => {
  it.each(REMIX_CHIPS)('%s changes the runner and the child still passes the arcade verifier', (chip) => {
    const child = remix(chip, parent);
    expect(child.control).toBe('runner');
    expect(child).not.toEqual(parent);
    expect(publishable(child)).toBe(true);
  });

  it('harder changes exactly one track parameter, up to the ceiling', () => {
    let spec = parent;
    for (let round = 0; round < 8; round += 1) {
      const ops = remixPatch('harder', spec);
      if (ops.length === 0) break;
      expect(ops.map((op) => op.path.split('/').slice(0, 3).join('/'))).toHaveLength(1);
      expect(ops[0].path).toMatch(/^\/controlParams\/(speed|density|lengthM)$/);
      spec = remix('harder', spec);
    }
    expect(spec.controlParams).toMatchObject({ speed: 'fast', density: 'high', lengthM: 500 });
  });

  it('twist adds a rule the arcade reads and swap_enemy picks another obstacle set', () => {
    const added = new Set<string>();
    for (let seed = 1; seed <= 6; seed += 1) {
      const twisted = remix('twist', parent, seed);
      const rules = twisted.mechanics.map((m) => m.id).filter((id) => id === 'health' || id === 'timer');
      expect(rules).toHaveLength(1);
      added.add(rules[0]);
    }
    expect([...added].sort()).toEqual(['health', 'timer']);
    const swapped = remix('swap_enemy', parent);
    expect(swapped.controlParams?.obstacles).toBeDefined();
    expect(swapped.controlParams?.obstacles).not.toEqual(parent.controlParams?.obstacles);
  });
});
