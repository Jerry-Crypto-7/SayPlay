import { draftGameSpec } from '@/play/draft';
/**
 * Švy obálky nad skutečnými vrstvami (P23-D T1): každý archetyp se zkompiluje
 * do platného, hratelného a navzájem odlišného světa, verifikátor ho pustí
 * k publikaci a týž spec + seed dá týž `worldHash`. Režisér bez modelu vrací
 * návrh ze slov a nikam nevolá.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GAME_COMPILER_VERSION } from '@/play/contracts';
import { ARCHETYPE_IDS, type ArchetypeId } from '@/play/registry';
import { readGameSpec, type GameSpecV1 } from '@/play/spec';
import { validateBlueprint } from '@/worldstream/schema';
import { bindRuntime } from '@/worldstream/runtime-controller';

import { getCompiler } from '../_compiler';
import { getDirector } from '../_director';
import { reportFor } from '../_report';

const fixturesDir = fileURLToPath(new URL('../../../../play/__fixtures__/', import.meta.url));

function fixtureSpec(archetype: ArchetypeId): GameSpecV1 {
  const raw = JSON.parse(readFileSync(`${fixturesDir}${archetype}.json`, 'utf8')) as unknown;
  const result = readGameSpec(raw);
  if (!result.ok) throw new Error(`${archetype}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

describe('getCompiler + reportFor', () => {
  it('compiles all eight archetypes into distinct, valid, playable, publishable worlds', () => {
    const compile = getCompiler();
    const hashes = new Set<string>();
    for (const archetype of ARCHETYPE_IDS) {
      const result = compile(fixtureSpec(archetype), 1);
      if (!result.ok) throw new Error(`${archetype}: ${result.reason} ${result.issues.join('; ')}`);
      const compiled = result.value;
      expect(compiled.compilerVersion).toBe(GAME_COMPILER_VERSION);
      if (compiled.blueprint === null) throw new Error(`${archetype}: expected a grid game`);
      expect(validateBlueprint(compiled.blueprint).ok).toBe(true);
      expect(bindRuntime(null, 'x', compiled.blueprint.world).controller.actions.length).toBeGreaterThanOrEqual(1);
      const report = reportFor(compiled);
      expect(report.keypoints.length, archetype).toBeGreaterThan(0);
      expect(report.publishEligible, archetype).toBe(true);
      hashes.add(compiled.worldHash);
    }
    expect(hashes.size).toBe(ARCHETYPE_IDS.length);
  });

  it('is deterministic for the same spec and seed', () => {
    const compile = getCompiler();
    const spec = fixtureSpec('collect_exit');
    const [first, second] = [compile(spec, 7), compile(spec, 7)];
    if (!first.ok || !second.ok) throw new Error('compile failed');
    expect(first.value.worldHash).toBe(second.value.worldHash);
  });
});

describe('getDirector bez modelu', () => {
  it('vrací návrh ze slov; větev bez konfigurace nikam nesáhne', async () => {
    delete process.env.WORLDSMITH_BRANCH;
    const game = await getDirector(Date.now(), 'test-caller')('A hamster escapes a supermarket while a giant Roomba hunts it.');
    expect(game.source).toBe('draft');
    // Návrh nové hry je od P32B T2 žánr: útěk v Aréně, archetyp mu dává modul.
    expect(game.spec).toEqual(draftGameSpec('A hamster escapes a supermarket while a giant Roomba hunts it.'));
    expect(game.fallbackReason).toBe('MODEL_UNAVAILABLE');
  });
});
