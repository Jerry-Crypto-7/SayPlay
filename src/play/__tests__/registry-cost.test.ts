/**
 * `estimateCost` je horní mez (P23-D, R1): `readGameSpec` z něj počítá
 * `budgets.maxRules`, takže podhodnocený odhad pustí spec, jehož skutečný svět
 * rozpočet přeteče. Počítá se svět, jak ho vidí runtime – pravidla adaptérů
 * i systémová `sys.moveTo.*` z `buildRuntimeWorld`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';

import { compileSim } from '../compile';
import { ARCHETYPE_IDS, estimateCost } from '../registry';
import { readGameSpec, type GameSpecV1 } from '../spec';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

function fixture(name: string): GameSpecV1 {
  const raw = JSON.parse(readFileSync(`${fixturesDir}${name}.json`, 'utf8'));
  const result = readGameSpec(raw);
  if (!result.ok) throw new Error(`${name}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

function compiledRules(spec: GameSpecV1, seed: number): number {
  const compiled = compileSim(spec, seed);
  if (!compiled.ok) throw new Error(`${spec.archetype}/${seed}: ${compiled.reason} ${compiled.issues.join('; ')}`);
  const built = buildRuntimeWorld(compiled.value.sim);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world.ir.rules.length;
}

describe('estimateCost', () => {
  it('never undercounts the rules the compiler emits (every fixture, seeds 1–8)', () => {
    for (const id of ARCHETYPE_IDS) {
      const spec = fixture(id);
      const estimate = estimateCost(spec.mechanics, spec.roles).rules;
      for (let seed = 1; seed <= 8; seed += 1) {
        expect(compiledRules(spec, seed), `${id} seed ${seed}`).toBeLessThanOrEqual(estimate);
      }
    }
  });
});
