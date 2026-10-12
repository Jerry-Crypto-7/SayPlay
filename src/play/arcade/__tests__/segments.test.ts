/**
 * Scénář úseků (P46B T3): úsek 2 i úsek 3 běžce přinese hratelnou změnu proti
 * úseku před ním. Rozvrh za běhu nikdo nevidí (ani robot, jen měřidlo P46B),
 * proto test čte svět: první krok rozvrhu v úseku je nepřítel, kterého žádný
 * dřívější krok neměl, a spawnů nepřibylo.
 */

import { describe, expect, it } from 'vitest';

import type { ArcadeParts } from '../addons';
import { arcadeWorldOf, generatorOf, preloadPhysics } from '../compile';
import { type ArcadeWorld, type PieceRef, nativeRule } from '../contract';
import { MODE_GENERATORS } from '../library';
import { loadRapier } from '../physics/world';
import { BEHAVIOURS } from '../pieces/behaviours';
import { type PacingRuleParams, withPacing } from '../pieces/pacing';
import { RUNNER_FOES } from '../pieces/pacing-parts';
import { type SegmentCast, type SegmentChange, type SegmentStep, segmentScriptOf, segmentSpans } from '../pieces/segments';
import { createCompileRng } from '@/play/compile/rng';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';

const SEEDS = Array.from({ length: 40 }, (_, index) => index + 1);
/** Běžec s hrozbami R2 a fázemi křivky (90/100/115 % na začátku rozjezdu, úseku 2 a 3). */
const RUNNER_CAST: SegmentCast = { foes: RUNNER_FOES.actors, speeds: [90, 100, 115] };

const scriptOf = (seed: number, cast: SegmentCast = RUNNER_CAST): SegmentStep[] => segmentScriptOf(createCompileRng(seed, 'pacing'), 'runner', cast);
const foeOf = (step: SegmentStep): string | undefined => step.changes.find((change): change is Extract<SegmentChange, { kind: 'newFoe' }> => change.kind === 'newFoe')?.behaviour;
const speedOf = (step: SegmentStep): number | undefined => step.changes.find((change): change is Extract<SegmentChange, { kind: 'speedTier' }> => change.kind === 'speedTier')?.percent;

describe('segment script', () => {
  it('draws the same script from the same seed, both lane foes open segment 2 across seeds, the swarm segment 3', () => {
    for (const seed of SEEDS) expect(scriptOf(seed)).toEqual(scriptOf(seed));
    expect(new Set(SEEDS.map((seed) => foeOf(scriptOf(seed)[0] as SegmentStep)))).toEqual(new Set(['flanker', 'sniper']));
    // Hejno smí až od vrcholu: úsek 3 dostane nepřítele, který dřív přijít nesměl, a úsek 2 o žádného nepřijde.
    expect(new Set(SEEDS.map((seed) => foeOf(scriptOf(seed)[1] as SegmentStep)))).toEqual(new Set(['swarm']));
    const early = RUNNER_FOES.actors.filter((actor) => actor.behaviour !== 'swarm');
    expect(new Set(SEEDS.map((seed) => foeOf(scriptOf(seed, { foes: early, speeds: [] })[1] as SegmentStep)))).toEqual(new Set(['flanker', 'sniper']));
  });

  it('gives segments 2 and 3 a playable change each: a foe no earlier segment had, allowed there, and the next speed tier', () => {
    for (const seed of SEEDS) {
      const script = scriptOf(seed);
      expect(script.map((step) => [step.at, step.until])).toEqual(segmentSpans());
      const [second, third] = script as [SegmentStep, SegmentStep];
      expect(foeOf(second)).toBeDefined();
      expect(foeOf(third)).toBeDefined();
      expect(foeOf(third)).not.toBe(foeOf(second));
      for (const step of script) {
        expect(RUNNER_FOES.actors.find((actor) => actor.behaviour === foeOf(step))!.from).toBeLessThanOrEqual(step.at);
      }
      expect(script.map(speedOf)).toEqual([100, 115]);
    }
  });

  it('never lowers intensity: speed tiers only rise, a flat or slower phase is no change', () => {
    expect(scriptOf(1, { foes: [], speeds: [90, 100, 115] }).map((step) => step.changes)).toEqual([[{ kind: 'speedTier', percent: 100 }], [{ kind: 'speedTier', percent: 115 }]]);
    expect(scriptOf(1, { foes: [], speeds: [100, 100, 90] }).map((step) => step.changes)).toEqual([[], []]);
    // Bez fází a bez hrozeb (trať, kam se R2 nevejdou) scénář nic neslibuje.
    expect(scriptOf(1, { foes: [], speeds: [] }).map((step) => step.changes)).toEqual([[], []]);
  });

  it('keeps the runner free of terrain and density changes: extra rows would close the free lane', () => {
    for (const step of scriptOf(3, { ...RUNNER_CAST, terrain: ['moving'], density: [1, 2, 3] })) {
      expect(step.changes.map((change) => change.kind).sort()).toEqual(['newFoe', 'speedTier']);
    }
  });
});

const CELLS = liveCells().filter((cell) => {
  const spec = compileRecipe(assemblyOfCell(cell));
  return spec.genre !== undefined && spec.assemblyParts === undefined && generatorOf(spec) === 'runner_track';
});

const chain = (ref: PieceRef): PieceRef[] => {
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? [ref] : [ref, ...chain(base)];
};

/** Rychlost fází světa v % na postupu `at` ‰. */
function speedAt(world: ArcadeWorld, at: number): number {
  const phases = chain(world.control).find((ref) => ref.id === 'phase_control')?.params.phases as readonly { start: number; speedPercent: number }[];
  return [...phases].reverse().find((phase) => phase.start <= at)!.speedPercent;
}

/** Kroky rozvrhu chování (bez bosse) v pravidle `pacing`. */
function laneSchedule(rules: readonly PieceRef[]): PacingRuleParams['schedule'] {
  const rule = nativeRule(rules, 'pacing')?.params as PacingRuleParams;
  // Boss finále (T4) přijde mimo los rozvrhu a scénář úseků se ho netýká.
  const lanes = new Set(rule.behaviours!.filter((ref) => ref.id !== 'boss').map((ref) => ref.template));
  return rule.schedule.filter((entry) => lanes.has(entry.template));
}

/** První krok úseku 2 i 3 je nepřítel, kterého žádný dřívější krok neměl. */
function expectFreshSegments(schedule: PacingRuleParams['schedule'], label: string): void {
  for (const [at, until] of segmentSpans()) {
    const first = schedule.find((entry) => entry.atPermille >= at);
    expect(first?.atPermille, `${label}: step in segment ${at}`).toBeLessThan(until);
    const earlier = new Set(schedule.filter((entry) => entry.atPermille < at).map((entry) => entry.template));
    expect(earlier.has(first!.template), `${label}: segment ${at} opens with a foe seen before`).toBe(false);
  }
}

/**
 * Rozvrh z `withPacing` s hrozbami běžce (bez fází). Rozvrh nezávisí na úrovni, jen na semínku, rozpočtu a
 * chováních – stačí části kteréhokoli generátoru (vzor `pacing-pieces.test.ts`) a semínko dá týž rozvrh jako běžec.
 */
function pacedSchedule(seed: number, foes: typeof RUNNER_FOES.actors, scripted: boolean): PacingRuleParams['schedule'] {
  const mode = MODE_GENERATORS.arena_escape!;
  const parts = mode.parts(seed, mode.params.parse({}), undefined) as ArcadeParts;
  const actors = foes.map((actor) => ({ body: BEHAVIOURS[actor.behaviour].body, behaviour: actor.behaviour, from: actor.from }));
  const setup = { seed, goal: { by: 'distance' as const, need: parts.level.length, limit: 7200 }, space: 'track' as const, spots: [0, 40_000], behaviours: actors, budget: RUNNER_FOES.budget, from: 200 };
  return laneSchedule(withPacing(parts, scripted ? { ...setup, segments: 'runner' } : setup).rules);
}

describe('withPacing follows the script', () => {
  it('holds back a segment 3 foe that could have come earlier, so segment 3 still opens with it', () => {
    const early = RUNNER_FOES.actors.filter((actor) => actor.behaviour !== 'swarm');
    for (const seed of SEEDS) {
      const schedule = pacedSchedule(seed, early, true);
      expect(schedule).toHaveLength(RUNNER_FOES.budget);
      expectFreshSegments(schedule, `seed ${seed}`);
    }
  });

  it('keeps every foe the schedule had: the displaced one takes a later step of the new foe (seed 7 lost its sniper)', () => {
    for (const seed of SEEDS) {
      const kinds = (scripted: boolean): Set<number> => new Set(pacedSchedule(seed, RUNNER_FOES.actors, scripted).map((entry) => entry.template));
      expect([...kinds(false)].filter((template) => !kinds(true).has(template)), `seed ${seed}: foes lost to the script`).toEqual([]);
    }
  });
});

describe('runner worlds follow the script', () => {
  it('covers the live runner cells', () => {
    expect(CELLS.map((cell) => cell.id)).toEqual(expect.arrayContaining(['runner.default', 'run.escape']));
  });

  for (const cell of CELLS) {
    it(`${cell.id}: the first step of segments 2 and 3 brings a foe no earlier step had, with no extra spawns`, async () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      await preloadPhysics(spec, loadRapier);
      for (const seed of SEEDS.slice(0, 20)) {
        const made = arcadeWorldOf(spec, seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        const schedule = laneSchedule(made.world.rules);
        expect(schedule, `${cell.id} seed ${seed}: budget`).toHaveLength(RUNNER_FOES.budget);
        expectFreshSegments(schedule, `${cell.id} seed ${seed}`);
        // Intenzita neklesá: úsek jede rychleji než ten před ním.
        for (const [at] of segmentSpans()) expect(speedAt(made.world, at)).toBeGreaterThan(speedAt(made.world, at - 1));
      }
    }, 120_000);
  }
});
