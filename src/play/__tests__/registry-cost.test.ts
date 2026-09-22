/**
 * `estimateCost` je horní mez (P23-D, R1): `readGameSpec` z něj počítá
 * `budgets.maxRules`, takže podhodnocený odhad pustí spec, jehož skutečný svět
 * rozpočet přeteče. Počítá se svět, jak ho vidí runtime – pravidla adaptérů
 * i systémová `sys.moveTo.*` z `buildRuntimeWorld`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';

import { compileSim } from '../compile';
import { MECHANICS, type MechanicEntry, estimateCost } from '../registry';
import { readGameSpec, type GameSpecV1 } from '../spec';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
/** Každá platná fixtura, i varianty archetypů (P25B a P25D v `p25d/`) – ne jen osm šablon. */
const FIXTURES = [
  ...readdirSync(fixturesDir).filter((file) => file.endsWith('.json') && !file.startsWith('invalid-')),
  ...readdirSync(`${fixturesDir}p25d`).map((file) => `p25d/${file}`),
].map((file) => file.slice(0, -'.json'.length));

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
    for (const id of FIXTURES) {
      const spec = fixture(id);
      const estimate = estimateCost(spec.mechanics, spec.roles).rules;
      for (let seed = 1; seed <= 8; seed += 1) {
        expect(compiledRules(spec, seed), `${id} seed ${seed}`).toBeLessThanOrEqual(estimate);
      }
    }
  });
});

describe('setsStates', () => {
  it('declares every state the compiler sets on a role instance (every fixture)', () => {
    for (const id of FIXTURES) {
      const spec = fixture(id);
      const declared = new Set<string>();
      for (const mechanic of spec.mechanics) {
        const entry = MECHANICS[mechanic.id] as MechanicEntry<unknown>;
        for (const [role, state] of entry.setsStates?.(entry.params.parse(mechanic.params)) ?? []) declared.add(`${role}:${state}`);
      }
      const compiled = compileSim(spec, 1);
      if (!compiled.ok) throw new Error(id);
      const { sim } = compiled.value;
      for (const rule of Object.values(sim.rules)) {
        for (const action of rule.actions) {
          if (action.kind !== 'setState') continue;
          const role = sim.entities[String(action.target)]?.role;
          expect(declared, `${id} ${rule.id}`).toContain(`${role}:${action.value}`);
        }
      }
    }
  });
});
