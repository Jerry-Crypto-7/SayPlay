/**
 * Nepřátelé na stanovišti (P51 T6). Úkol na stanovišti měl jen kola, spěch a kopie stanovišť – telemetrie v něm
 * neviděla žádnou hrozbu (věty panelu m04 a u03: 0 chování). Nová hra (`genre.v5`) má dva vrhače zezadu kuchyně
 * (`STATION_FOES`): první přijde se začátkem druhého kola, druhý (větší, role nepřítele) se spěchem – stupňování,
 * ne kulisa. Robot úkolu jim uhýbá sám podél pultu (`quest-bot.ts`, `close`), `pacing_bot` neuhýbá (`own`).
 * Uložená `genre.v4` hra staví týž svět bez nich (`p51-stored-v4.test.ts`, `station-rush.test.ts`).
 *
 * Brány v každé živé buňce stanoviště (12 semínek): nečinný nevyhraje, přehrání = hash, intermediate ≥ 0,8, jeho
 * výhry mají finále a aspoň dvě chování telemetrie, novice 0,3–0,7. Co by vypadalo dobře a bylo špatně: vrhač,
 * který nikdy nehodí (telemetrie by ho viděla jako `static`, ale hráč by neuhýbal) – proto i výstřely v běhu.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { behavioursOf } from '../../../../evals/play/p45c/pacing';
import { arcadeWorldOf, generatorOf } from '../compile';
import { ARCADE_HZ, type ArcadeWorld, type PieceRef, underlyingRule } from '../contract';
import { SHOT } from '../pieces/behaviours/sniper';
import { STATION_FOES } from '../pieces/pacing-parts';
import { loadRapier } from '../physics/world';
import { funMetrics, traceRun } from '../telemetry';
import { runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { GameSpecV1 } from '@/play/spec';

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const STATION_CELLS = liveCells().filter((cell) => generatorOf(compileRecipe(assemblyOfCell(cell))) === 'quest_station');
const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
const storedV4Of = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v4' } });
const pacingOf = (world: ArcadeWorld): PieceRef | undefined => world.rules.map(underlyingRule).find((rule) => rule.id === 'pacing');
interface PacingParams {
  readonly schedule: readonly { readonly atPermille: number; readonly template: number }[];
  readonly behaviours?: readonly { readonly id: string; readonly template: number }[];
  readonly foeSpots?: readonly number[];
}

beforeAll(async () => {
  await loadRapier();
});

describe('P51 T6: station quests have foes', () => {
  it('covers the live station cell', () => {
    expect(STATION_CELLS.map((cell) => cell.id)).toEqual(['quest.station']);
  });

  for (const cell of STATION_CELLS) {
    it(`${cell.id}: a new game brings a thrower with round 2 and a second one with the rush; a stored genre.v4 game has none`, () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      for (const seed of SEEDS.slice(0, 3)) {
        const world = worldOf(spec, seed);
        const pacing = pacingOf(world)!.params as unknown as PacingParams;
        expect(pacing.behaviours?.map((ref) => ref.id), `${cell.id} seed ${seed}`).toEqual(['sniper', 'sniper']);
        expect(behavioursOf(world)).toContain('sniper');
        expect(pacing.foeSpots).toEqual(STATION_FOES.spots);
        const [first, rush] = pacing.behaviours!.map((ref) => pacing.schedule.find((entry) => entry.template === ref.template)!.atPermille);
        expect(first).toBeLessThan(rush!);
        expect(first).toBeLessThanOrEqual(200);
        // Druhý vrhač přijde se spěchem, spolu s kopiemi stanovišť.
        const interact = (world.rules.map(underlyingRule).find((rule) => rule.id === 'interact')!.params as { when: { interact: { rounds: number; rush?: { round: number } } } }).when.interact;
        expect(interact.rush, `${cell.id} seed ${seed}: rush`).toBeDefined();
        const copies = pacing.schedule.filter((entry) => !pacing.behaviours!.some((ref) => ref.template === entry.template));
        expect(copies.map((entry) => entry.atPermille)).toEqual([rush]);
        expect(rush).toBe(Math.floor((interact.rush!.round * 1000) / interact.rounds));
        const stored = worldOf(storedV4Of(spec), seed);
        expect((pacingOf(stored)!.params as unknown as PacingParams).behaviours, `${cell.id} seed ${seed}: v4`).toBeUndefined();
        expect(behavioursOf(stored)).toEqual([]);
      }
    });

    it(`${cell.id}: idle never wins, replay equal, intermediate ≥ 0.8 with a finale and ≥ 2 behaviours, novice 0.3–0.7`, () => {
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
        const trace = traceRun(world, bot.inputs);
        const metrics = funMetrics(trace);
        expect(metrics.behaviourCount, `${cell.id} seed ${seed}: behaviours ${metrics.behaviours.join(', ')}`).toBeGreaterThanOrEqual(2);
        // Vrhač opravdu hází: výstřely přeletí kuchyň (vzniknou po startu a zmizí za hranou plochy).
        const shots = trace.samples.flatMap((sample) => sample.bodies.filter((body) => body.y === SHOT.y && body.born > 0).map((body) => `${body.body}@${body.born}`));
        expect(new Set(shots).size, `${cell.id} seed ${seed}: shots`).toBeGreaterThanOrEqual(4);
        if (bot.outcome === 'won') {
          intermediate += 1;
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeGreaterThanOrEqual(30);
          if (metrics.finale.why !== null) finales += 1;
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
