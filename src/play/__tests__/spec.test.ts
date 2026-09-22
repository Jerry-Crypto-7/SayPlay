/**
 * `GameSpec v1` – co drží schéma a registr (P23 základ).
 *
 * Osm fixtur je po jedné na archetyp a všechny musí projít; tři neplatné
 * musí spadnout **na pojmenovaný důvod**, ne jen „neprošlo“ – opravné kolo
 * režiséra se řídí důvodem, takže špatný důvod je špatná oprava.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ARCHETYPES, ARCHETYPE_IDS, MECHANICS, MECHANIC_IDS, REGISTRY_LIMITS, estimateCost } from '../registry';
import { gameSpecHash, readGameSpec, type GameSpecV1 } from '../spec';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`${name}.json`, `file://${fixturesDir.replace(/\\/g, '/')}`), 'utf8'));
}

function valid(name: string): GameSpecV1 {
  const result = readGameSpec(fixture(name));
  if (!result.ok) throw new Error(`${name}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

describe('registry', () => {
  it('keys match ids and every archetype requirement is a registered mechanic', () => {
    for (const id of MECHANIC_IDS) expect(MECHANICS[id].id).toBe(id);
    for (const id of ARCHETYPE_IDS) {
      expect(ARCHETYPES[id].id).toBe(id);
      for (const mechanic of ARCHETYPES[id].requiredMechanics) {
        expect(MECHANIC_IDS).toContain(mechanic);
        expect(ARCHETYPES[id].allowedMechanics).toContain(mechanic);
      }
    }
  });

  it('has eight archetypes and no projectile, jump or moving platform', () => {
    expect(ARCHETYPE_IDS).toHaveLength(8);
    for (const forbidden of ['projectile', 'jump', 'moving_platform']) expect(MECHANIC_IDS).not.toContain(forbidden);
  });
});

describe('readGameSpec', () => {
  it('accepts one fixture per archetype and the fixture names its archetype', () => {
    for (const id of ARCHETYPE_IDS) {
      const spec = valid(id);
      expect(spec.archetype).toBe(id);
      expect(spec.objective.kind).toBe(ARCHETYPES[id].objective);
    }
  });

  it('keeps every valid fixture under the registry ceiling', () => {
    for (const id of ARCHETYPE_IDS) {
      const spec = valid(id);
      const cost = estimateCost(spec.mechanics, spec.roles);
      expect(cost.entities).toBeLessThanOrEqual(REGISTRY_LIMITS.maxEntities);
      expect(cost.rules).toBeLessThanOrEqual(REGISTRY_LIMITS.maxRules);
    }
  });

  it('rejects an unknown mechanic as MALFORMED_SPEC (closed enum, fail closed)', () => {
    const result = readGameSpec(fixture('invalid-unknown-mechanic'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('MALFORMED_SPEC');
      expect(result.issues.join('\n')).toContain('/mechanics/2/id');
    }
  });

  it('rejects a spec whose estimate exceeds its own budget', () => {
    const result = readGameSpec(fixture('invalid-over-budget'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('BUDGET_EXCEEDED');
  });

  it('rejects an objective pointing at a role the spec never declares', () => {
    const result = readGameSpec(fixture('invalid-dangling-role'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('OBJECTIVE_MISMATCH');
  });

  it('rejects a mechanic outside its archetype and bad params with MECHANIC_REJECTED', () => {
    const spec = valid('collect_exit');
    const wrongArchetype = { ...spec, mechanics: [...spec.mechanics, { id: 'carry', params: { itemRole: 'mushroom', destinationRole: 'portal', fragile: false } }] };
    const outside = readGameSpec(wrongArchetype);
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.reason).toBe('MECHANIC_REJECTED');

    const badParams = { ...spec, mechanics: [{ id: 'collectible', params: { role: 'mushroom', count: 999 } }, spec.mechanics[1]] };
    const params = readGameSpec(badParams);
    expect(params.ok).toBe(false);
    if (!params.ok) {
      expect(params.reason).toBe('MECHANIC_REJECTED');
      expect(params.issues.join('\n')).toContain('/mechanics/0/params/count');
    }
  });

  it('demands exactly one player role', () => {
    const spec = valid('collect_exit');
    const twoPlayers = { ...spec, roles: [...spec.roles, { id: 'player2', kind: 'player', label: 'second fox', count: 1 }] };
    const result = readGameSpec(twoPlayers);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('DANGLING_REFERENCE');
  });

  it('demands a mechanic on every keypoint and rejects a keypoint proving nothing registered', () => {
    const spec = valid('collect_exit');
    const orphan = { ...spec, verification: [{ id: 'k', kind: 'keypoint', assert: { runState: 'won' } }] };
    const result = readGameSpec(orphan);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('DANGLING_REFERENCE');
  });

  it('hashes canonically: key order does not move the hash, a value does', () => {
    const spec = valid('collect_exit');
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(spec).reverse()))) as GameSpecV1;
    expect(gameSpecHash(reordered)).toBe(gameSpecHash(spec));
    expect(gameSpecHash({ ...spec, title: 'Six Mushrooms' })).not.toBe(gameSpecHash(spec));
  });

  it('fixture directory holds nothing but the twelve files this test names', () => {
    const files = readdirSync(fixturesDir).filter((name) => name.endsWith('.json')).sort();
    expect(files).toEqual([...ARCHETYPE_IDS, 'collect_exit_stealth', 'invalid-dangling-role', 'invalid-over-budget', 'invalid-unknown-mechanic'].map((n) => `${n}.json`).sort());
  });
});
