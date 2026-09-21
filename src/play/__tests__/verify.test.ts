/**
 * Keypoint verifikátor a `QualityReport` (P23-A, T9).
 *
 * Verifikátor je nehlídaná brána publikace, proto se drží obojí: osm fixtur
 * musí projít celé (`publishEligible`), a **záměrně rozbitá** kompilace musí
 * zčervenat právě na tom tvrzení, které ji popisuje.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { canonicalHash } from '@/ir/worlddoc';
import { verifyWitness } from '@/verify/witness';

import { type CompiledGame, GAME_COMPILER_VERSION } from '../contracts';
import { compileGame, compileSim } from '../compile';
import { ADAPTERS, type AdapterTable } from '../compile/adapters';
import { collectible } from '../compile/adapters/collectible';
import { hazardZone } from '../compile/adapters/hazard-zone';
import { assembleBlueprint } from '../compile/blueprint';
import type { MechanicAdapter, SurfaceRule } from '../compile/types';
import { ARCHETYPE_IDS } from '../registry';
import { type GameSpecV1, readGameSpec } from '../spec';
import { verifyGame } from '../verify';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

function raw(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`${name}.json`, `file://${fixturesDir.replace(/\\/g, '/')}`), 'utf8')) as Record<string, unknown>;
}

function spec(input: unknown, name: string): GameSpecV1 {
  const result = readGameSpec(input);
  if (!result.ok) throw new Error(`${name}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

function compile(gameSpec: GameSpecV1, seed: number): CompiledGame {
  const result = compileGame(gameSpec, seed);
  if (!result.ok) throw new Error(`${gameSpec.title}/${seed}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

/** Kompilace s podvrženou tabulkou adaptérů – ocas `compileGame` bez jeho brány. */
function compileWith(gameSpec: GameSpecV1, seed: number, adapters: AdapterTable): CompiledGame {
  const compilation = compileSim(gameSpec, seed, adapters);
  if (!compilation.ok) throw new Error(`${gameSpec.title}: ${compilation.reason} ${compilation.issues.join('; ')}`);
  const blueprint = assembleBlueprint(gameSpec, seed, compilation.value);
  const built = buildRuntimeWorld(blueprint.world.sim);
  if (!built.ok) throw new Error(built.issues.join('; '));
  const verdict = verifyWitness(built.world, built.world.trace);
  return {
    spec: gameSpec,
    specHash: canonicalHash(gameSpec),
    seed,
    compilerVersion: GAME_COMPILER_VERSION,
    blueprint,
    worldHash: blueprint.world.simHash,
    mechanics: compilation.value.mechanics,
    roles: compilation.value.roles,
    winsAtTick: verdict.verdict === 'CERTIFIED' ? verdict.witnessLength : null,
  };
}

const report = (name: string, seed = 1) => verifyGame(compile(spec(raw(name), name), seed));

describe('verifyGame – the eight fixtures', () => {
  it('proves every assertion of all eight archetypes over the real runtime', () => {
    const lines: string[] = [];
    for (const archetype of ARCHETYPE_IDS) {
      const quality = report(archetype);
      const failed = quality.keypoints.filter((keypoint) => !keypoint.passed);
      const detail = failed.map((keypoint) => `${keypoint.assertionId} ${keypoint.failures.join(', ')}`).join(' | ');
      lines.push(`${archetype}: ${quality.publishEligible ? 'eligible' : `NOT eligible ${detail}`}`);
    }
    expect(lines.filter((line) => line.endsWith(': eligible')), lines.join('\n')).toHaveLength(8);
  });

  it('reports one piece of evidence per assertion, certified witness and budgets under the spec', () => {
    for (const archetype of ARCHETYPE_IDS) {
      const gameSpec = spec(raw(archetype), archetype);
      const compiled = compile(gameSpec, 1);
      const quality = verifyGame(compiled);
      expect(quality.specHash, archetype).toBe(compiled.specHash);
      expect(quality.worldHash, archetype).toBe(compiled.worldHash);
      expect(quality.keypoints.map((keypoint) => keypoint.assertionId), archetype).toEqual(gameSpec.verification.map((a) => a.id));
      expect(quality.witness, archetype).toEqual({ certified: true, winsAtTick: compiled.winsAtTick });
      expect(quality.replayEqual, archetype).toBe(true);
      expect(quality.budgets.entities, archetype).toBeLessThanOrEqual(gameSpec.budgets.maxEntities);
      expect(quality.budgets.rules, archetype).toBeLessThanOrEqual(gameSpec.budgets.maxRules);
      expect(quality.budgets.triangles, archetype).toBeNull();
    }
  });

  it('gives every assertion its own runtime, so the report is the same twice', () => {
    expect(report('collect_exit')).toEqual(report('collect_exit'));
    expect(report('switch_puzzle')).toEqual(report('switch_puzzle'));
  });

  it('records what the keypoint moved: the fifth mushroom changes the hashed state', () => {
    const keypoint = report('collect_exit').keypoints.find((candidate) => candidate.assertionId === 'fifth_opens_portal');
    expect(keypoint?.mechanicId).toBe('collectible');
    expect(keypoint?.hashBefore).not.toBe(keypoint?.hashAfter);
    expect(keypoint?.ticks).toBeGreaterThan(0);
  });
});

describe('verifyGame – broken games go red', () => {
  it('fails green_blocks when green joins the required combination', () => {
    const broken = raw('switch_puzzle');
    const mechanics = broken.mechanics as { id: string; params: Record<string, unknown> }[];
    const switchMechanic = mechanics.find((mechanic) => mechanic.id === 'switch') as { params: Record<string, unknown> };
    switchMechanic.params.required = ['red', 'blue', 'green'];

    const quality = verifyGame(compile(spec(broken, 'switch_puzzle+green'), 1));
    const keypoint = quality.keypoints.find((candidate) => candidate.assertionId === 'green_blocks');
    expect(keypoint?.passed).toBe(false);
    expect(keypoint?.failures.join(' ')).toContain('door locked is false');
    expect(quality.publishEligible).toBe(false);
  });

  it('fails lava_off_is_safe when the hazard stops asking whether it is on', () => {
    // Startovní pravidlo bez stráže `stateIs on`: svědek to nepozná (kolem
    // lávy chodí), keypoint ano – stojí ve vypnuté lávě a čeká, že neublíží.
    const blind: MechanicAdapter<never> = (params, ctx) => {
      const output = (hazardZone as MechanicAdapter<never>)(params, ctx);
      const rules: Record<string, SurfaceRule> = {};
      for (const [id, rule] of Object.entries(output.rules)) {
        const operands = (rule.condition?.operands ?? []) as { kind: string }[];
        rules[id] = id.endsWith('.start') ? { ...rule, condition: operands.find((operand) => operand.kind === 'inZone') ?? null } : rule;
      }
      return { ...output, rules };
    };

    const compiled = compileWith(spec(raw('hazard_crossing'), 'hazard_crossing'), 1, { ...ADAPTERS, hazard_zone: blind });
    expect(compiled.winsAtTick, 'the broken world must stay winnable').not.toBeNull();
    const quality = verifyGame(compiled);
    const keypoint = quality.keypoints.find((candidate) => candidate.assertionId === 'lava_off_is_safe');
    expect(keypoint?.passed).toBe(false);
    expect(keypoint?.failures.join(' ')).toContain('runState is lost');
    expect(quality.publishEligible).toBe(false);
  });

  it('keeps passing when the collectible counter only gains headroom', () => {
    // Plán chtěl jako druhého mutanta sběr s `count: 6`. Naměřeno: strop
    // čítače hru nerozbije – výherní stráž čte `objective.count` (5), ne
    // parametr mechaniky, takže pátá houba dál počítá. Mutant, který
    // `fifth_opens_portal` shodí, hru zároveň znehratelní a kompilace ho
    // odmítne dřív, než se k verifikátoru dostane; proto ho nahradil slepý
    // hazard výše.
    const roomy: MechanicAdapter<never> = (params, ctx) =>
      (collectible as MechanicAdapter<never>)({ ...(params as object), count: 6 } as never, ctx);
    const compiled = compileWith(spec(raw('collect_exit'), 'collect_exit'), 1, { ...ADAPTERS, collectible: roomy });
    const quality = verifyGame(compiled);
    expect(quality.keypoints.find((candidate) => candidate.assertionId === 'fifth_opens_portal')?.passed).toBe(true);
  });
});

describe('verifyGame – a wrong expectation fails on its own channel', () => {
  /** Fixtura s jedním tvrzením přepsaným: `assert` se nahradí celý. */
  function withAssert(name: string, assertionId: string, assert: Record<string, unknown>): CompiledGame {
    const broken = raw(name);
    const assertions = broken.verification as { id: string; assert: Record<string, unknown> }[];
    (assertions.find((assertion) => assertion.id === assertionId) as { assert: Record<string, unknown> }).assert = assert;
    return compile(spec(broken, `${name}/${assertionId}`), 1);
  }

  const cases: readonly [string, string, Record<string, unknown>, string][] = [
    ['collect_exit', 'fifth_opens_portal', { counters: { collected: 4 } }, 'counter collected is 5, expected 4'],
    ['collect_exit', 'fifth_opens_portal', { firedMechanics: ['zone_trigger'] }, 'zone_trigger never fired'],
    ['switch_puzzle', 'red_blue_opens', { entityStates: { blue: 'off' } }, 'entity blue is in state on'],
    ['combat_lite', 'hit_removes_slime', { runState: 'running' }, 'runState is won'],
  ];

  it.each(cases)('%s/%s', (name, assertionId, assert, failure) => {
    const quality = verifyGame(withAssert(name, assertionId, assert));
    const keypoint = quality.keypoints.find((candidate) => candidate.assertionId === assertionId);
    expect(keypoint?.passed).toBe(false);
    expect(keypoint?.failures.join(' ')).toContain(failure);
    expect(quality.publishEligible).toBe(false);
  });

  it('fails reachability when the witness never wins', () => {
    // Východ jen signalizuje: svět se postaví, ale svědek do výhry nedojde.
    const signalOnly: MechanicAdapter<never> = (params, ctx) =>
      (ADAPTERS.zone_trigger as MechanicAdapter<never>)({ ...(params as object), effect: 'signal' } as never, ctx);
    const compiled = compileWith(spec(raw('collect_exit'), 'collect_exit'), 1, { ...ADAPTERS, zone_trigger: signalOnly });
    const quality = verifyGame(compiled);
    expect(quality.witness.certified).toBe(false);
    expect(quality.keypoints.find((candidate) => candidate.assertionId === 'winnable')?.failures.join(' ')).toContain('reachability: NO_WIN');
    expect(quality.publishEligible).toBe(false);
  });
});
