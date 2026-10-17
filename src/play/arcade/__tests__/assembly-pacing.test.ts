/**
 * Hry s díly (P42) s průběhem (P46B R2): běžec a skákačka s díly dostanou úseky, hrozby a bosse jako hry bez dílů.
 * Robot dílu rozhoduje nad robotem průběhu; průběh, který by hru s díly potichu udělal neprůchodnou, by měřidlo
 * hlásilo jen jako nehratelnou větu. Proto test hraje skutečné věty majitele (b02 díl `fight`, b03 díl `escape`
 * s pronásledovatelem) a „obby“ skákačky (díl `hazard` s pádem) robotem intermediate.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { compileRecipe } from '@/play/compose/compile';
import { draftGameSpecWithMeta } from '@/play/draft';

import { arcadeWorldOf, generatorOf, preloadPhysics } from '../compile';
import { nativeRule } from '../contract';
import { loadRapier } from '../physics/world';
import type { PacingRuleParams } from '../pieces/pacing';
import { funMetrics, traceRun } from '../telemetry';
import { runBot } from '../verify';
import { segmentRun } from '../../../../evals/play/p46b/segments';

const SEEDS = [1, 2, 3, 4];
/**
 * `changes` = nejmenší počet úseků 2 a 3 se změnou v měřidle. Skákačka i bez dílů změní na části semínek jen úsek 2:
 * rychlost úseku 3 (115 %) robot v medianu nevyjede (`platformer.default` semínka 2, 11, 15 z 1–20, stejně jako s díly).
 */
const SENTENCES = [
  { id: 'b02', text: 'Amanita mushrooms fight bulls, flee and shoot them', generator: 'runner_track', part: 'fight', changes: 2 },
  { id: 'b03', text: 'A hamster escapes a supermarket while a Roomba hunts it', generator: 'runner_track', part: 'escape', changes: 2 },
  { id: 's021', text: 'obby game with lava and spinning bars', generator: 'platform_level', part: 'hazard', changes: 1 },
];

beforeAll(async () => { await loadRapier(); });

describe('paced games with parts', () => {
  it.each(SENTENCES)('$id ($part part) gets a boss finale, still wins with every part played, and beats the boss each time', async ({ text, generator, part, changes }) => {
    const spec = draftGameSpecWithMeta(text, 1).spec;
    expect(spec.assemblyParts?.map((one) => one.kind)).toContain(part);
    expect(generatorOf(spec)).toBe(generator);
    await preloadPhysics(spec, loadRapier);
    for (const seed of SEEDS) {
      const made = arcadeWorldOf(spec, seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const world = made.world;
      expect((nativeRule(world.rules, 'pacing')?.params as PacingRuleParams | undefined)?.finale, `seed ${seed}`).toBe('boss');
      expect(nativeRule(world.rules, 'assembly_part'), `seed ${seed}: the part still plays`).toBeDefined();
      const run = runBot(world, undefined, { profile: 'intermediate' });
      // Výhru hry s díly dá `assembly_finish` až s hotovými díly: výhra = díl odehraný.
      expect(run.outcome, `seed ${seed}`).toBe('won');
      expect(funMetrics(traceRun(world, run.inputs)).finale.why, `seed ${seed}: boss falls`).toBe('boss');
      expect(segmentRun(world, run.inputs).segmentChanges, `seed ${seed}: segments that change`).toBeGreaterThanOrEqual(changes);
    }
  }, 300_000);

  it('leaves a platform level with a chaser part unpaced: the chaser takes a life in the first second', () => {
    const spec = compileRecipe({ preset: 'assembled', move: 'jump', actions: [], objective: 'reach', threats: [],
      content: { genre: 'platformer', mode: 'default', hero: 'seal', setting: 'snow' }, parts: [{ kind: 'chaser', role: 'part_0', label: 'bear', phase: 0, motion: 'fall' }] });
    const made = arcadeWorldOf(spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(generatorOf(spec)).toBe('platform_level');
    expect(nativeRule(made.world.rules, 'pacing')).toBeUndefined();
  });
});
