/**
 * Průběh dráhových žánrů (P45C T11): každá živá buňka běžce, poletování a
 * závodu dostane fáze z křivky napětí a závěrečný sprint. Robot intermediate
 * vyhraje ≥ 7/8, nečinný hráč nikdy, délka 30–90 s, přehrání = hash.
 * Plošinovka a chování v pruzích běžce: nálezy pod plánem P45C. Odchylka:
 * závod do prvního nárazu (`voyage.race`) si nechá rampu (`GENRE_PACING.voyage_race`).
 */

import { describe, expect, it } from 'vitest';

import { finaleOf, pressureRun } from '../../../../evals/play/p45c/pacing';
import { arcadeWorldOf, generatorOf, preloadPhysics } from '../compile';
import { ARCADE_HZ, type ArcadeWorld, type PieceRef } from '../contract';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { GameSpecV1 } from '@/play/spec';

const TRACK = ['runner_track', 'flap_track', 'voyage_race'];
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const CELLS = liveCells().filter((cell) => {
  const spec = compileRecipe(assemblyOfCell(cell));
  return spec.genre !== undefined && TRACK.includes(generatorOf(spec));
});
/** Odchylka T11: závod do prvního nárazu (`crashBudget` 1) jede s rampou, ne s křivkou. */
const RAMPED = ['voyage.race'];

const worldOf = (spec: GameSpecV1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
/** Tatáž hra uložená před průběhem (`genre.v1`). */
const storedOf = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v1' } });

const chain = (ref: PieceRef): PieceRef[] => {
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? [ref] : [ref, ...chain(base)];
};
const phasesOf = (world: ArcadeWorld): unknown => chain(world.control).find((ref) => ref.id === 'phase_control')?.params.phases;

describe('track genres are paced', () => {
  it('covers every live track cell with a genre', () => {
    expect(CELLS.map((cell) => cell.id).sort()).toEqual(expect.arrayContaining(['runner.default', 'run.escape', 'flap.default', 'flap.collect', 'voyage.race']));
  });

  for (const cell of CELLS.filter((candidate) => !RAMPED.includes(candidate.id))) {
    it(`${cell.id}: curve phases, final sprint, bot wins 7/8 in 30–90 s, idle loses, replay equal`, async () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      await preloadPhysics(spec, loadRapier);
      let wins = 0;
      for (const seed of SEEDS) {
        const made = arcadeWorldOf(spec, seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        const { world } = made;
        expect(chain(world.control).map((ref) => ref.id)).toContain('pacing_control');
        expect(phasesOf(world)).toEqual([{ start: 0, speedPercent: 90 }, { start: 200, speedPercent: 100 }, { start: 650, speedPercent: 115 }, expect.objectContaining({ start: 850, speedPercent: 125 })]);
        expect(finaleOf(world)).toBe(true);
        const verdict = verifyArcade(world, ARCADE_LIBRARY, made.roleBindings);
        expect(verdict.idle.outcome, `${cell.id} seed ${seed}: idle`).not.toBe('won');
        expect(verdict.replayEqual).toBe(true);
        const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
        const run = pressureRun(world, bot.inputs);
        expect(run.hash).toBe(bot.hash);
        if (bot.outcome === 'won') {
          wins += 1;
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeGreaterThanOrEqual(30);
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeLessThanOrEqual(90);
        }
      }
      expect(wins, `${cell.id}: intermediate wins`).toBeGreaterThanOrEqual(7);
    }, 300_000);
  }

  it('keeps the phases a spec brings over the curve', () => {
    const cell = CELLS.find((candidate) => candidate.id === 'runner.default')!;
    const own = [{ start: 0, speedPercent: 100 }, { start: 500, speedPercent: 110 }];
    const made = arcadeWorldOf(compileRecipe({ ...assemblyOfCell(cell), phases: own }), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(phasesOf(made.world)).toEqual(own);
    expect(chain(made.world.control).map((ref) => ref.id)).toContain('pacing_control');
  });

  it('keeps the ramp in a race lost on the first crash (deviation T11)', () => {
    const spec = compileRecipe(assemblyOfCell(CELLS.find((candidate) => candidate.id === 'voyage.race')!));
    const world = worldOf(spec);
    expect(chain(world.control).map((ref) => ref.id)).not.toContain('pacing_control');
    expect(world).toEqual(worldOf(storedOf(spec)));
  });

  it('checks a paced race with a ramp corner by corner: only the final sprint stretches the river', () => {
    const race = compileRecipe(assemblyOfCell(CELLS.find((candidate) => candidate.id === 'voyage.race')!));
    // Tentýž závod se třemi nárazy průběh dostane.
    const spec = { ...race, controlParams: { ...race.controlParams, crashBudget: 3 } };
    const paced = worldOf(spec), stored = worldOf(storedOf(spec));
    expect(phasesOf(paced)).toBeDefined();
    // Celá trať natažená o 125/120 by byla o 4 % delší; jen finále (od 850 ‰) přidá 0,6 %.
    expect(paced.length / stored.length).toBeGreaterThan(1);
    expect(paced.length / stored.length).toBeLessThan(1.01);
  });

  it('runs the runner curve over the ramp middle level and stretches only from the peak', () => {
    const spec = compileRecipe(assemblyOfCell(CELLS.find((candidate) => candidate.id === 'runner.default')!));
    const paced = worldOf(spec), stored = worldOf(storedOf(spec));
    const runner = chain(paced.control).find((ref) => ref.id === 'runner')!;
    // Jedna značka na startu (+10 %), druhá za cílem se nepřejede.
    expect(runner.params.ramp).toEqual([0, expect.any(Number)]);
    expect((runner.params.ramp as number[])[1]).toBeGreaterThan(paced.length);
    // Vrchol 115 % nad úrovní 110 % přesáhne vrchol rampy 120 %: od 650 ‰ natažení 126,5/120, před ním trať beze změny.
    expect(paced.length / stored.length).toBeGreaterThan(1.04);
    expect(paced.length / stored.length).toBeLessThan(1.06);
  });
});
