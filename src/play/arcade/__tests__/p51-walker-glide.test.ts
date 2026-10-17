/**
 * Chodec a klouzání s průběhem a finále (P51 T3). Nativní spec nemá `genre`, takže novou hru pozná značka
 * `segments` v parametrech generátoru (vzor řízení P46B T5, `pacedNative`): průběh `still` s finále `sprint`
 * a svět, jehož konec telemetrie uzná jako `climax` – chodec má východ v nejvzdálenější buňce a závěrečnou
 * stezku jisker přes celou chodbu, klouzání delší trať s tunelem hustých kruhů na konci. Hra bez značky
 * (uložená, nebo složená s díly P42) staví týž svět jako dřív (`p51-stored-v4.test.ts`).
 * Brány v každé živé buňce (12 semínek): nečinný nevyhraje, přehrání = hash, intermediate ≥ 0,8,
 * novice 0,3–0,7; výhry intermediate mají finále.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf, generatorOf } from '../compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, FLAG, HEADER, type PieceRef, UNIT, bodyBase, underlyingRule } from '../contract';
import { GLIDE, GLIDE_FINALE } from '../pieces/glide';
import { WALKER_FINALE } from '../pieces/walker';
import { loadRapier } from '../physics/world';
import { funMetrics, traceRun } from '../telemetry';
import { runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { RecipeAssembly } from '@/play/compose/presets';
import type { GameSpecV1 } from '@/play/spec';

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const CELLS = liveCells().filter((cell) => /^(?:walker_|glide_course$)/.test(generatorOf(compileRecipe(assemblyOfCell(cell)))));
const cellSpec = (id: string): GameSpecV1 => compileRecipe(assemblyOfCell(CELLS.find((cell) => cell.id === id)!));
/** Tatáž hra bez značky nové hry: uložená před P51. */
const storedOf = (spec: GameSpecV1): GameSpecV1 => {
  const { segments: _segments, ...params } = spec.controlParams as Record<string, unknown>;
  return { ...spec, controlParams: params as GameSpecV1['controlParams'] };
};
const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
const ruleOf = (world: ArcadeWorld, id: string): PieceRef | undefined => world.rules.map(underlyingRule).find((rule) => rule.id === id);
/** Živá těla druhu `kind` na startu (předlohy průběhu ne). */
const bodiesOf = (world: ArcadeWorld, kind: string): number[] =>
  Array.from({ length: world.initial[HEADER.bodyCount]! }, (_, body) => body).filter(
    (body) => world.kinds[world.initial[bodyBase(body) + BODY.kind]!] === kind && (world.initial[bodyBase(body) + BODY.flags]! & FLAG.alive) !== 0,
  );
const kindsOf = (world: ArcadeWorld, kind: string): number => bodiesOf(world, kind).length;
const ringZs = (world: ArcadeWorld): number[] => bodiesOf(world, 'glide-ring').map((body) => world.initial[bodyBase(body) + BODY.z]!);

beforeAll(async () => {
  await loadRapier();
});

describe('P51 T3: walker and glide games are paced to a finale', () => {
  it('covers the seven walker and eight glide cells', () => {
    expect(CELLS.filter((cell) => cell.id.startsWith('walk.'))).toHaveLength(7);
    expect(CELLS.filter((cell) => cell.id.startsWith('glide.'))).toHaveLength(8);
  });

  for (const cell of CELLS) {
    it(`${cell.id}: a new game carries the mark and the pacing rule with the sprint finale; without the mark it does not`, () => {
      const spec = cellSpec(cell.id);
      expect((spec.controlParams as { segments?: boolean }).segments).toBe(true);
      const world = worldOf(spec);
      expect((ruleOf(world, 'pacing')?.params as { finale?: string } | undefined)?.finale).toBe('sprint');
      const stored = worldOf(storedOf(spec));
      expect(ruleOf(stored, 'pacing')).toBeUndefined();
      if (cell.id.startsWith('walk.')) {
        expect(kindsOf(world, 'spark')).toBe(WALKER_FINALE.trail);
        expect(kindsOf(stored, 'spark')).toBe(0);
      } else {
        // Tunel: poslední kruhy po `GLIDE_FINALE.spacing`, bez značky všude `GLIDE.spacing`.
        const zs = ringZs(world);
        expect(zs.at(-1)! - zs.at(-2)!).toBe(GLIDE_FINALE.spacing);
        expect(new Set(ringZs(stored).map((z, i, all) => (i === 0 ? z : z - all[i - 1]!)))).toEqual(new Set([GLIDE.spacing]));
      }
    });

    it(`${cell.id}: idle never wins, replay equal, intermediate ≥ 0.8 with a finale, novice 0.3–0.7`, () => {
      const spec = cellSpec(cell.id);
      let intermediate = 0;
      let finales = 0;
      let novice = 0;
      const seconds: number[] = [];
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const verdict = verifyArcade(world);
        expect(verdict.idle.outcome, `${cell.id} seed ${seed}: idle`).not.toBe('won');
        expect(verdict.replayEqual, `${cell.id} seed ${seed}: replay`).toBe(true);
        const bot = runBot(world, undefined, { profile: 'intermediate' });
        if (bot.outcome === 'won') {
          intermediate += 1;
          seconds.push(bot.tick / ARCADE_HZ);
          if (funMetrics(traceRun(world, bot.inputs)).finale.why !== null) finales += 1;
        }
        if (runBot(world, undefined, { profile: 'novice' }).outcome === 'won') novice += 1;
      }
      const runs = `runs ${seconds.map((s) => s.toFixed(1)).join(' ')}`;
      expect(intermediate / SEEDS.length, `${cell.id}: intermediate (${runs})`).toBeGreaterThanOrEqual(0.8);
      expect(finales / intermediate, `${cell.id}: finale in wins (${runs})`).toBeGreaterThanOrEqual(0.8);
      expect(novice / SEEDS.length, `${cell.id}: novice`).toBeGreaterThanOrEqual(0.3);
      expect(novice / SEEDS.length, `${cell.id}: novice`).toBeLessThanOrEqual(0.7);
      // Klouzání: tunel na konci delší trati; obojí aspoň 15 s, jinak posledních 10 s nemůže být 1,5× hustších.
      expect(Math.min(...seconds), `${cell.id}: ${runs}`).toBeGreaterThan(15);
    });
  }

  it.each([['glide', 'voyage', 'race'], ['walk', 'quest', 'spatial']])('builds an assembled %s with parts (P42) as before: no mark, no pacing; without parts it is a new game', (move, genre, mode) => {
    const recipe = { preset: 'assembled', move, actions: [], objective: 'reach', threats: [], content: { genre, mode, hero: 'seal', setting: 'snow' } } as unknown as RecipeAssembly;
    const parted = compileRecipe({ ...recipe, parts: [{ kind: 'catch', role: 'part_0', label: 'fish', phase: 0, motion: 'fall' }] });
    expect(parted.controlParams).not.toHaveProperty('segments');
    expect(ruleOf(worldOf(parted), 'pacing')).toBeUndefined();
    const plain = compileRecipe({ ...recipe, parts: [] });
    expect(plain.controlParams).toMatchObject({ segments: true });
    expect((ruleOf(worldOf(plain), 'pacing')?.params as { finale?: string } | undefined)?.finale).toBe('sprint');
  });

  it('the glide tunnel is within the delayed steering reach and the course fits the body budget', () => {
    expect(GLIDE_FINALE.spacing).toBeLessThan(GLIDE.spacing);
    for (const cell of CELLS.filter((c) => c.id.startsWith('glide.'))) {
      for (const seed of SEEDS) expect(arcadeWorldOf(cellSpec(cell.id), seed).ok, `${cell.id} seed ${seed}`).toBe(true);
    }
    expect(UNIT).toBe(1000);
  });
});
