/**
 * P63 T7: nebezpečí, které přidá čtení věty, nesmí startovat na hrdinovi. Od T2 (`82bb9481`) dostane hra po čtení
 * s002 „collect three keys … while dodging ghosts“ (aréna) duchy jako díl `hazard`. Aréna nemá délku trati, takže díl
 * dopadl 2,8 m od startu hrdiny. Nečinný hráč u něj přežije, ale kamera arény míří k nejbližší hrozbě a hráč, který
 * klepne doprostřed nebo jde dopředu, do ducha vejde: ve snímcích T6a tři životy za ~4 s. Na pohled hra vypadá dobře,
 * proto test drží místo dílu: aspoň tak daleko od hrdiny jako pronásledovatel arény (`ESCAPE.minDistancePct`).
 * Táž cesta nese netopýry h10, tuleně h16 a žraloky h09.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { ARCADE_HZ, BODY, COUNTER, HEADER, bodyBase } from '@/play/arcade/contract';
import { arcadeWorldOf, compileArcade } from '@/play/arcade/compile';
import { instantiate, loadProgram, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { ARENA, ESCAPE } from '@/play/arcade/pieces/arena';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft/draft';
import type { Reading } from '@/play/read/schema';
import type { GameSpecV1 } from '@/play/spec';

import oldReadings from '../../../../evals/play/p63/readings.astra.json';
import p63Readings from '../../../../evals/play/p63/readings.p63.astra.json';

const SENTENCES = [
  { id: 's002', sentence: 'A knight must collect three keys in a haunted castle while dodging ghosts.' },
  { id: 'h10', sentence: 'Grab ten gold coins in a haunted castle without waking the bats' },
  { id: 'h16', sentence: 'A penguin slides across the ice, catches fish and avoids seals' },
  { id: 'h09', sentence: 'A diver collects four pearls from a coral reef while avoiding sharks' },
];

/** Pronásledovatel arény startuje aspoň tak daleko od hráče (`arena.ts`, kontrola útěku). */
const LEAST = (ARENA.half * ESCAPE.minDistancePct) / 100;

type Rows = { readonly rows: readonly { readonly id: string; readonly models: Record<string, { readonly reading: unknown }> }[] };
const readingOf = (id: string): Reading =>
  ((p63Readings as Rows).rows.find((row) => row.id === id) ?? (oldReadings as Rows).rows.find((row) => row.id === id))!.models['astra@openai'].reading as Reading;
const readingGame = (id: string, sentence: string): GameSpecV1 => draftGameSpecWithMeta(sentence, 1, { reading: readingOf(id) }).spec;

/** Semínka publikace (`derivedSeeds`) a jedno navíc. */
const seedsOf = (sentence: string): number[] => {
  const base = seedFrom(sentence);
  return [...derivedSeeds(base), seedFrom({ base, attempt: 4 })];
};

const worldOf = (spec: GameSpecV1, seed: number) => {
  const built = arcadeWorldOf(spec, seed);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
};

type PartRule = { readonly id: string; readonly params: { readonly control?: string; readonly part?: { readonly kind: string; readonly startX: number; readonly startZ: number } } };

beforeAll(async () => {
  await loadRapier();
}, 60_000);

describe('P63 T7: a foe the reading adds never starts on the hero', () => {
  it.each(SENTENCES)('$id: the hazard starts as far from the hero as an arena chaser', ({ id, sentence }) => {
    const spec = readingGame(id, sentence);
    for (const seed of seedsOf(sentence)) {
      const world = worldOf(spec, seed);
      const state = instantiate(world), p = bodyBase(state[HEADER.player]!);
      const rules = world.rules as readonly PartRule[];
      const hazards = rules.filter((rule) => rule.id === 'assembly_part' && rule.params.part?.kind === 'hazard');
      expect(hazards.length, `${id} seed ${seed}`).toBeGreaterThan(0);
      expect(hazards[0]!.params.control, id).toBe('move_free');
      for (const { params } of hazards) {
        const gap = Math.hypot(params.part!.startX - state[p + BODY.x]!, params.part!.startZ - state[p + BODY.z]!);
        expect(gap, `${id} seed ${seed}`).toBeGreaterThanOrEqual(LEAST);
      }
    }
  });

  it.each(SENTENCES)('$id: an idle player keeps every life for the first 5 s', ({ id, sentence }) => {
    const spec = readingGame(id, sentence);
    for (const seed of seedsOf(sentence)) {
      const world = worldOf(spec, seed);
      const state = instantiate(world), program = loadProgram(world, ARCADE_LIBRARY);
      const lives = state[HEADER.counters + COUNTER.health]!;
      for (let tick = 0; tick < 5 * ARCADE_HZ && state[HEADER.runState] === 0; tick++) step(state, { axis: 0, buttons: 0 }, program);
      expect(state[HEADER.counters + COUNTER.health], `${id} seed ${seed}`).toBe(lives);
    }
  }, 60_000);

  it.each(SENTENCES)('$id: the robot still wins on a publish seed', ({ id, sentence }) => {
    const spec = readingGame(id, sentence);
    const won = derivedSeeds(seedFrom(sentence)).some((seed) => {
      const compiled = compileArcade(spec, seed);
      return compiled.ok && compiled.value.winsAtTick !== null;
    });
    expect(won, id).toBe(true);
  }, 120_000);
});
