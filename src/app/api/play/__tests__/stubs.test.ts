/**
 * Dvojníci kompilátoru a režiséra pro P23-C: každý archetyp dá hratelný,
 * ověřený a navzájem odlišný svět; režisér pozná archetyp ze slov ve větě;
 * tentýž spec + seed dá tentýž `worldHash`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ARCHETYPE_IDS, type ArchetypeId } from '@/play/registry';
import { readGameSpec, type GameSpecV1 } from '@/play/spec';
import { validateBlueprint } from '@/worldstream/schema';
import { bindRuntime } from '@/worldstream/runtime-controller';

import { getCompiler } from '../_compiler';
import { getDirector } from '../_director';
import { stubReport } from '../_report';

const fixturesDir = fileURLToPath(new URL('../../../../play/__fixtures__/', import.meta.url));

function fixtureSpec(archetype: ArchetypeId): GameSpecV1 {
  const raw = JSON.parse(readFileSync(`${fixturesDir}${archetype}.json`, 'utf8')) as unknown;
  const result = readGameSpec(raw);
  if (!result.ok) throw new Error(`${archetype}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

describe('getCompiler (stub)', () => {
  it('compiles all eight archetypes into distinct, valid, playable, winnable worlds', () => {
    const compile = getCompiler();
    const hashes = new Set<string>();
    for (const archetype of ARCHETYPE_IDS) {
      const spec = fixtureSpec(archetype);
      const result = compile(spec, 1);
      if (!result.ok) throw new Error(`${archetype}: ${result.reason} ${result.issues.join('; ')}`);
      const compiled = result.value;
      expect(compiled.spec.archetype).toBe(archetype);
      expect(compiled.seed).toBe(1);
      expect(validateBlueprint(compiled.blueprint).ok).toBe(true);
      const binding = bindRuntime(null, 'x', compiled.blueprint.world);
      expect(binding.controller.actions.length).toBeGreaterThanOrEqual(1);
      expect(compiled.winsAtTick).not.toBeNull();
      hashes.add(compiled.worldHash);
    }
    expect(hashes.size).toBe(ARCHETYPE_IDS.length);
  });

  it('is deterministic for the same spec and seed and reports its own version', () => {
    const compile = getCompiler();
    const spec = fixtureSpec('collect_exit');
    const first = compile(spec, 7);
    const second = compile(spec, 7);
    if (!first.ok || !second.ok) throw new Error('compile failed');
    expect(first.value.worldHash).toBe(second.value.worldHash);
    expect(first.value.compilerVersion).toBe('stub-authored-v1');

    const report = stubReport(first.value);
    expect(report.publishEligible).toBe(true);
    expect(report.keypoints).toEqual([]);
    expect(report.witness.certified).toBe(true);
    expect(report.witness.winsAtTick).toBe(first.value.winsAtTick);
    expect(report.specHash).toBe(first.value.specHash);
    expect(report.worldHash).toBe(first.value.worldHash);
    expect(report.budgets.entities).toBeGreaterThan(0);
    expect(report.stub).toBe(true);
  });
});

describe('getDirector (stub)', () => {
  it('maps keywords to an archetype and keeps the sentence as title', async () => {
    const sentence = 'A hamster escapes while a Roomba hunts it';
    const result = await getDirector()(sentence);
    if (!result.ok) throw new Error(`${result.reason} ${result.issues.join('; ')}`);
    expect(result.spec.archetype).toBe('chase_escape');
    expect(result.spec.title).toBe(sentence);
    expect(result.source).toBe('draft');
    expect(result.repairRounds).toBe(0);
  });

  it('falls back to collect_exit for an unknown sentence', async () => {
    const result = await getDirector()('Something quiet happens');
    if (!result.ok) throw new Error(`${result.reason} ${result.issues.join('; ')}`);
    expect(result.spec.archetype).toBe('collect_exit');
  });
});
