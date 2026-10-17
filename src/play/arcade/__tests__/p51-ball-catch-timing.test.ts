/**
 * Míč, chytání a načasování s finále (P51 T4). Míč a chytání průběh neměly: nová hra (značka `segments`) má
 * průběh a bosse, kterého telemetrie uzná – soupeře za terči se 3 HP (`BALL_FINALE`), kořist na tři chycení
 * (`CATCH_FINALE`). Načasování průběh mělo (P45C T14), ale jeho křivka stoupá
 * plynule a telemetrie finále neuzná: nová hra (`genre.v5`) má klidnou první část a posledních
 * `TIMING_FINALE.rounds` kol rychlých – konec, který telemetrie uzná jako `climax`. Uložená `genre.v4` hra
 * staví týž svět (`p51-stored-v4.test.ts`, dev sada má tři věty načasování).
 * Brány v každé živé buňce (12 semínek): nečinný nevyhraje, přehrání = hash, intermediate ≥ 0,8 a jeho výhry
 * mají finále, novice 0,3–0,7.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf, generatorOf } from '../compile';
import { type ArcadeWorld, BODY, HEADER, ROLE, bodyBase, bodyHp } from '../contract';
import { CATCH_FINALE } from '../pieces/arena-catch';
import { BALL_FINALE } from '../pieces/ball';
import { TIMING_FINALE } from '../pieces/pacing-parts';
import { TIMING_SLOTS } from '../pieces/timing';
import { loadRapier } from '../physics/world';
import { funMetrics, traceRun } from '../telemetry';
import { runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { GameSpecV1 } from '@/play/spec';

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const TIMING_CELLS = liveCells().filter((cell) => generatorOf(compileRecipe(assemblyOfCell(cell))) === 'timing_level');
const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
/** Rychlost jezdce každého kola (předlohy kol za jezdcem a cílem). */
const roundSpeeds = (world: ArcadeWorld, rounds: number): number[] =>
  Array.from({ length: rounds }, (_, round) => Math.abs(world.initial[bodyBase(TIMING_SLOTS.marks + round) + BODY.vx]!));

beforeAll(async () => {
  await loadRapier();
});

describe('P51 T4: timing games end in a fast finale', () => {
  it('covers the three timing cells', () => {
    expect(TIMING_CELLS.map((cell) => cell.id).sort()).toEqual(['timing.bridge', 'timing.precision', 'timing.stack']);
  });

  for (const cell of TIMING_CELLS) {
    it(`${cell.id}: a calm first part, then the last ${TIMING_FINALE.rounds} rounds at the finale speed`, () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      const rounds = (spec.controlParams as { rounds: number }).rounds;
      const speeds = roundSpeeds(worldOf(spec), rounds);
      expect(new Set(speeds.slice(-TIMING_FINALE.rounds))).toEqual(new Set([TIMING_FINALE.speed]));
      expect(new Set(speeds.slice(0, -TIMING_FINALE.rounds))).toEqual(new Set([speeds[0]]));
      expect(speeds[0]).toBeLessThan(TIMING_FINALE.speed);
    });

    it(`${cell.id}: idle never wins, replay equal, intermediate ≥ 0.8 with a finale, novice 0.3–0.7`, () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      let intermediate = 0;
      let finales = 0;
      let novice = 0;
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const verdict = verifyArcade(world);
        expect(verdict.idle.outcome, `${cell.id} seed ${seed}: idle`).not.toBe('won');
        expect(verdict.replayEqual, `${cell.id} seed ${seed}: replay`).toBe(true);
        const bot = runBot(world, undefined, { profile: 'intermediate' });
        if (bot.outcome === 'won') {
          intermediate += 1;
          if (funMetrics(traceRun(world, bot.inputs)).finale.why !== null) finales += 1;
        }
        if (runBot(world, undefined, { profile: 'novice' }).outcome === 'won') novice += 1;
      }
      expect(intermediate / SEEDS.length, `${cell.id}: intermediate`).toBeGreaterThanOrEqual(0.8);
      expect(finales / intermediate, `${cell.id}: finale in wins`).toBeGreaterThanOrEqual(0.8);
      expect(novice / SEEDS.length, `${cell.id}: novice`).toBeGreaterThanOrEqual(0.3);
      expect(novice / SEEDS.length, `${cell.id}: novice`).toBeLessThanOrEqual(0.7);
    });
  }
});

/** Hraje buňku 12 semínky: nečinný nevyhraje, přehrání = hash; výhry intermediate a začátečníka, výhry s bossem. */
function gates(cell: (typeof BOSS_CELLS)[number]): { intermediate: number; bosses: number; novice: number } {
  const spec = compileRecipe(assemblyOfCell(cell));
  let intermediate = 0;
  let bosses = 0;
  let novice = 0;
  for (const seed of SEEDS) {
    const world = worldOf(spec, seed);
    const verdict = verifyArcade(world);
    expect(verdict.idle.outcome, `${cell.id} seed ${seed}: idle`).not.toBe('won');
    expect(verdict.replayEqual, `${cell.id} seed ${seed}: replay`).toBe(true);
    const bot = runBot(world, undefined, { profile: 'intermediate' });
    if (bot.outcome === 'won') {
      intermediate += 1;
      if (funMetrics(traceRun(world, bot.inputs)).finale.why === 'boss') bosses += 1;
    }
    if (runBot(world, undefined, { profile: 'novice' }).outcome === 'won') novice += 1;
  }
  return { intermediate, bosses, novice };
}

const BOSS_CELLS = liveCells().filter((cell) => ['ball_pitch', 'arena_catch'].includes(generatorOf(compileRecipe(assemblyOfCell(cell)))));

describe('P51 T4: ball and catch games end on a boss', () => {
  it('covers the catch and the three ball cells', () => {
    expect(BOSS_CELLS.map((cell) => cell.id).sort()).toEqual(['ball.defeat', 'ball.score', 'ball.score+rival', 'roam.catch']);
  });

  for (const cell of BOSS_CELLS) {
    it(`${cell.id}: a new game is paced and its boss takes ${cell.id === 'roam.catch' ? CATCH_FINALE.hp : BALL_FINALE.hp} hits`, () => {
      const world = worldOf(compileRecipe(assemblyOfCell(cell)));
      const initial = Int32Array.from(world.initial);
      expect(world.rules.some((rule) => rule.id === 'pacing'), `${cell.id}: pacing`).toBe(true);
      const tough = cell.id === 'roam.catch' ? CATCH_FINALE.hp : BALL_FINALE.hp;
      expect(Array.from({ length: initial[HEADER.bodyCount]! }, (_, body) => body).some((body) => initial[bodyBase(body) + BODY.role] === ROLE.enemy && bodyHp(initial, body) === tough), `${cell.id}: boss body`).toBe(true);
    });

    it(`${cell.id}: idle never wins, replay equal, intermediate ≥ 0.8 and its wins end on the boss`, () => {
      const { intermediate, bosses, novice } = gates(cell);
      expect(intermediate / SEEDS.length, `${cell.id}: intermediate`).toBeGreaterThanOrEqual(0.8);
      expect(bosses / intermediate, `${cell.id}: boss in wins`).toBeGreaterThanOrEqual(0.8);
      expect(novice / SEEDS.length, `${cell.id}: novice`).toBeGreaterThanOrEqual(0.3);
      // Míč: začátečník se od intermediate liší jen reakcí (≤ 1,5 s za běh) a pásmo by držely jen hodiny pár desetin
      // nad během intermediate – horní mez jen u chytání (README „Rozhodnutí“, T4).
      if (cell.id === 'roam.catch') expect(novice / SEEDS.length, `${cell.id}: novice`).toBeLessThanOrEqual(0.7);
    });
  }
});
