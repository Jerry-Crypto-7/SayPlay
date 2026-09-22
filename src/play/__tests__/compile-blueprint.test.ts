/**
 * `compileGame`: blueprint kolem zkompilovaného světa (P23-A, T8).
 *
 * Blueprint projde schématem i s objektem bez `entityId` – proto test drží
 * vazbu každé herní entity na právě jeden objekt, ne jen `validateBlueprint`.
 * Certifikace jde existujícím řetězem (`certifySteps`), stejným, kterým
 * prochází emise modelu, aby hra z kompilátoru nedostala měkčí bránu.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FAMILIES } from '@/geom/families';
import { chooseFamily } from '@/geom/family-choice';
import { simHashOf } from '@/ir/worlddoc';
import { certifySteps, type EmitPhase } from '@/model/certify';
import { findBlueprintReferenceIssues } from '@/worldstream/references';
import { type WorldstreamBlueprint, validateBlueprint } from '@/worldstream/schema';

import { compileGame } from '../compile';
import type { CompiledGame } from '../contracts';
import { ARCHETYPE_IDS } from '../registry';
import { readGameSpec, type GameSpecV1 } from '../spec';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

function fixture(name: string): GameSpecV1 {
  const raw = JSON.parse(readFileSync(new URL(`${name}.json`, `file://${fixturesDir.replace(/\\/g, '/')}`), 'utf8'));
  const result = readGameSpec(raw);
  if (!result.ok) throw new Error(`${name}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

type GridGame = CompiledGame & { readonly blueprint: WorldstreamBlueprint };

function compiled(spec: GameSpecV1, seed: number): GridGame {
  const result = compileGame(spec, seed);
  if (!result.ok) throw new Error(`${spec.title}/${seed}: ${result.reason} ${result.issues.join('; ')}`);
  if (result.value.blueprint === null) throw new Error(`${spec.title}: expected a grid game`);
  return result.value as GridGame;
}

/** Prožene `world` certifikačním řetězem modelu; vrátí dosažené fáze a výsledek. */
function certify(game: GridGame): { phases: EmitPhase[]; outcome: string; detail: string } {
  const { simHash: _sealed, ...body } = game.blueprint.world;
  const steps = certifySteps({
    promptId: game.spec.title,
    upstream: { model: 'none', system: '', user: '' },
    provenance: { source: 'play-compiler' },
    body,
  });
  const phases: EmitPhase[] = [];
  let next = steps.next();
  while (!next.done) {
    phases.push(next.value);
    next = steps.next();
  }
  const verdict = next.value.body;
  return { phases, outcome: verdict.outcome, detail: verdict.rejection ? `${verdict.rejection.reason}: ${verdict.rejection.detail}` : '' };
}

describe('compileGame – blueprint over the eight fixtures', () => {
  const games = ARCHETYPE_IDS.map((archetype) => [archetype, compiled(fixture(archetype), 1)] as const);

  it('passes the blueprint schema and has no dangling references', () => {
    for (const [archetype, game] of games) {
      const validation = validateBlueprint(game.blueprint);
      expect(validation.issues, archetype).toEqual([]);
      expect(validation.ok, archetype).toBe(true);
      expect(findBlueprintReferenceIssues(game.blueprint), archetype).toEqual([]);
      expect(game.blueprint.objects.length, archetype).toBeLessThanOrEqual(64);
    }
  });

  it('is certified by the model emission chain up to the witness phase', () => {
    for (const [archetype, game] of games) {
      const { phases, outcome, detail } = certify(game);
      expect(`${outcome} ${detail}`.trim(), archetype).toBe('CERTIFIED');
      expect(phases, archetype).toEqual(['emitted', 'schema', 'references', 'look', 'lowering', 'witness']);
      expect(game.winsAtTick, archetype).not.toBeNull();
    }
  });

  it('seals the world hash from sim alone and reports it as worldHash', () => {
    for (const [archetype, game] of games) {
      expect(simHashOf(game.blueprint.world), archetype).toBe(game.worldHash);
      expect(game.blueprint.world.simHash, archetype).toBe(game.worldHash);
      expect(game.compilerVersion).toBe('play-compiler-v3');
      expect(game.seed).toBe(1);
      expect(game.blueprint.sessionSeed).toBe(1);
    }
  });

  it('binds every game entity to exactly one visual object', () => {
    for (const [archetype, game] of games) {
      const entityIds = Object.keys(game.blueprint.world.sim.entities as Record<string, unknown>);
      const bound = game.blueprint.objects.map((object) => object.binding?.entityId).filter((id): id is string => id !== undefined);
      expect([...bound].sort(), archetype).toEqual([...entityIds].sort());
      for (const object of game.blueprint.objects) expect(object.stableId, archetype).toBe(object.binding?.entityId);
    }
  });

  it('draws catalog assets where a label matches and family geometry elsewhere', () => {
    const sources = new Map<string, string>();
    for (const [, game] of games) {
      for (const object of game.blueprint.objects) sources.set(`${game.spec.archetype}/${object.stableId}`, object.source.kind);
    }
    expect(sources.get('collect_exit/portal')).toBe('asset');
    expect(sources.get('delivery/table')).toBe('asset');
    expect(sources.get('switch_puzzle/red')).toBe('asset');
    expect(sources.get('switch_puzzle/door')).toBe('asset');
    // Od herních modelů z Blenderu (22. 9. 2026) mají model i sbíraná houba,
    // láva a liška (hráč fixtury).
    expect(sources.get('collect_exit/mushroom_1')).toBe('asset');
    expect(sources.get('collect_exit/player')).toBe('asset');
    expect(sources.get('hazard_crossing/lava_1')).toBe('asset');
    const assetShare = [...sources.values()].filter((kind) => kind === 'asset').length / sources.size;
    expect(assetShare).toBeGreaterThan(0.5);
  });

  // Rodina kulis je celá scéna a stavěla přímo na hrací plochu: rytíř a klíče
  // stáli uvnitř zdí a kamera za nimi (QA 22. 9. 2026).
  it('carves the scenery out of the play area and the camera side', () => {
    for (const [archetype, game] of games) {
      // Poslední řez je ten kolem hry; rodina (např. `works`) může mít vlastní.
      const carve = [...game.blueprint.geometry.nodes].reverse().find((node) => node.kind === 'carve');
      if (carve?.kind !== 'carve') throw new Error(`${archetype}: no carve`);
      for (const object of game.blueprint.objects) {
        for (const axis of [0, 1, 2]) {
          expect(object.targetBounds.min[axis], `${archetype}/${object.stableId}`).toBeGreaterThanOrEqual(carve.at[axis] - carve.size[axis] / 2);
          expect(object.targetBounds.max[axis], `${archetype}/${object.stableId}`).toBeLessThanOrEqual(carve.at[axis] + carve.size[axis] / 2);
        }
      }
      // Výchozí kamera přichází od +x/+z – tam musí řez sahat dál než za hru.
      expect(carve.at[0], archetype).toBeGreaterThan(0);
      expect(carve.at[2], archetype).toBeGreaterThan(0);
    }
  });

  it('chooses the family from the theme so the viewer picks the same one', () => {
    for (const [archetype, game] of games) {
      const family = chooseFamily(game.blueprint.world.look, game.seed);
      expect(FAMILIES.map((entry) => entry.id), archetype).toContain(family);
      const look = game.blueprint.world.look as { palette: string; atmosphere: string };
      expect(typeof look.palette, archetype).toBe('string');
      expect(typeof look.atmosphere, archetype).toBe('string');
    }
    // Sopečná jeskyně → works (ember), neonová aréna → spires (neon), volba ze slov, ne ze seedu.
    expect(chooseFamily(compiled(fixture('hazard_crossing'), 1).blueprint.world.look, 1)).toBe('works');
    expect(chooseFamily(compiled(fixture('checkpoint_race'), 1).blueprint.world.look, 1)).toBe('spires');
  });

  it('is deterministic per seed and differs across seeds', () => {
    const spec = fixture('collect_exit');
    expect(compiled(spec, 4).worldHash).toBe(compiled(spec, 4).worldHash);
    expect(JSON.stringify(compiled(spec, 4).blueprint)).toBe(JSON.stringify(compiled(spec, 4).blueprint));
    expect(compiled(spec, 4).worldHash).not.toBe(compiled(spec, 5).worldHash);
  });
});
