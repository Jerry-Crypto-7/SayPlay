/**
 * Knihovna úseků skákačky (P46D T5): každý vzor je průchodný z konstrukce
 * i pro robota, úroveň ze vzorů se mění se semínkem a hra žánru Skákačka
 * zůstane pro začátečníka férová. Uložené hry bez `chunks` staví tutéž úroveň.
 */

import { describe, expect, it } from 'vitest';

import { createCompileRng } from '@/play/compile/rng';
import { draftGameSpecWithMeta } from '@/play/draft';

import { arcadeWorldOf } from '../compile';
import { type ArcadeLevel, type BodyInit } from '../contract';
import { buildWorld } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { CHUNK_SHAPE, PLATFORM_CHUNKS, PLATFORM_CHUNK_LIBRARY, type PlatformChunkId, pickPlatformChunk } from '../pieces/platform-chunks';
import { PLATFORM, PLATFORM_DIFFICULTIES, type PlatformLevelParams, checkPlatformLevel, platformChunkLevel, platformControlRef, platformLevel, platformRules, platformSeconds } from '../pieces/platform';
import { type BotProfile, runBot, verifyArcade } from '../verify';

/** Parametry, jak je píše žánr Skákačka. */
const params = (extra: Record<string, unknown> = {}): PlatformLevelParams => platformLevel.params.parse({ checkpoints: true, feel: 2, sections: 3, chunks: 1, ...extra });

/** Svět bez životů: jeden hrot nebo pád prohrává. */
function worldOf(level: ArcadeLevel, track: PlatformLevelParams) {
  const built = buildWorld({ seed: 1, control: platformControlRef(track), rules: platformRules({ ...track, checkpoints: false }, undefined, platformSeconds(level, track.difficulty)), bot: { id: 'platform_bot', params: {} }, level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Knihovna jen s jedním vzorem, losovaným od nejlehčího úseku. */
const only = (id: PlatformChunkId) => PLATFORM_CHUNK_LIBRARY.filter((chunk) => chunk.id === id).map((chunk) => ({ ...chunk, from: 0 }));

const platforms = (level: ArcadeLevel): BodyInit[] => level.bodies.filter((body) => body.role === 'platform').sort((a, b) => a.z - b.z);

describe('knihovna úseků skákačky', () => {
  it('má osm vzorů a každý je průchodný na každé obtížnosti; nečinný prohraje', () => {
    expect(PLATFORM_CHUNKS).toHaveLength(8);
    for (const id of PLATFORM_CHUNKS) {
      for (const difficulty of PLATFORM_DIFFICULTIES) {
        for (let seed = 1; seed <= 3; seed += 1) {
          const track = params({ difficulty });
          const { level, chunks } = platformChunkLevel(seed * 7919, track, only(id));
          const label = `${id}/${difficulty}/${seed}`;
          expect(chunks, label).toContain(id);
          expect(checkPlatformLevel(level), label).toEqual([]);
          const verdict = verifyArcade(worldOf(level, track));
          expect(verdict.failures, label).toEqual([]);
          expect(verdict.idle.outcome, label).toBe('lost');
        }
      }
    }
  }, 300_000);

  it('20 semínek dá aspoň 6 různých sekvencí, žádný vzor dvakrát za sebou; druhý a třetí úsek otevře odpočinek s checkpointem', () => {
    const sequences = new Set<string>();
    for (let seed = 1; seed <= 20; seed += 1) {
      const { level, chunks } = platformChunkLevel(seed, params());
      expect(chunks.some((id, index) => id === chunks[index - 1]), `seed ${seed}: ${chunks.join(' ')}`).toBe(false);
      sequences.add(chunks.join(' '));
      expect(level.sectionStarts, `seed ${seed}`).toHaveLength(2);
      // Odpočinek uprostřed úseku checkpoint nemá: úseky jsou tři (P36A).
      expect(level.bodies.filter((body) => body.role === 'checkpoint'), `seed ${seed}`).toHaveLength(2);
      for (const start of level.sectionStarts ?? []) {
        const slab = platforms(level).find((body) => body.z - body.d / 2 === start);
        expect(slab?.d, `seed ${seed}`).toBe(CHUNK_SHAPE.restSlab);
        expect(level.bodies.some((body) => body.role === 'checkpoint' && body.z === start + 800), `seed ${seed}`).toBe(true);
      }
    }
    expect(sequences.size).toBeGreaterThanOrEqual(6);
  });

  it('nejlehčí úsek nebere pohyblivou plošinu, kry ani chodbu s ostny', () => {
    const rng = createCompileRng(1);
    const drawn = new Set(Array.from({ length: 200 }, () => pickPlatformChunk(rng, PLATFORM_CHUNK_LIBRARY, 0, undefined).id));
    expect([...drawn].sort()).toEqual(PLATFORM_CHUNK_LIBRARY.filter((chunk) => chunk.from === 0).map((chunk) => chunk.id).sort());
  });

  it('voda leží v mezeře pod hranou pádu, propadající se kry klesají nad vodou', () => {
    const water = platformChunkLevel(7919, params(), only('water')).level;
    const pools = water.bodies.filter((body) => body.kind === 'pool');
    expect(pools.length).toBeGreaterThan(0);
    const slabs = platforms(water);
    for (const pool of pools) {
      expect(pool.y + pool.h).toBeLessThan(PLATFORM.fallBelowY);
      expect(pool.solid).toBe(false);
      // Mezi dvěma deskami: od hrany jedné k hraně druhé.
      const before = slabs.filter((slab) => slab.z + slab.d / 2 <= pool.z).at(-1) as BodyInit;
      const after = slabs.find((slab) => slab.z - slab.d / 2 >= pool.z) as BodyInit;
      const [edge, next] = [before.z + before.d / 2, after.z - after.d / 2];
      expect(next - edge).toBe(pool.d);
      expect(Math.abs(pool.z - (edge + next) / 2)).toBeLessThanOrEqual(0.5);
    }
    // Kry: pevné (jádro by hráče v horním obratu svislé desky propustilo), každá níž než předchozí deska, pod mezerou před ní voda.
    for (const difficulty of PLATFORM_DIFFICULTIES) {
      const sinking = platformChunkLevel(7919, params({ difficulty }), only('sinking')).level;
      expect(sinking.bodies.some((body) => body.kinematic === true && (body.vy ?? 0) !== 0), difficulty).toBe(false);
      const path = platforms(sinking);
      const floes = path.filter((body) => body.d === CHUNK_SHAPE.sinkSlab);
      expect(floes.length, difficulty).toBeGreaterThanOrEqual(3);
      for (const floe of floes) {
        const previous = path[path.indexOf(floe) - 1] as BodyInit;
        const [prevTop, top] = [previous.y + previous.h, floe.y + floe.h];
        // Níž, dokud kry nedojdou na nejnižší výšku úrovně.
        expect(top < prevTop || top === PLATFORM.minTop, difficulty).toBe(true);
        expect(sinking.bodies.some((body) => body.kind === 'pool' && Math.abs(body.z + body.d / 2 - (floe.z - floe.d / 2)) <= 0.5), difficulty).toBe(true);
      }
    }
  });

  it('bez `chunks` úroveň jako dřív: žádná voda ani propadající se deska', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const level = platformLevel.generate(seed, params({ chunks: undefined }));
      expect(level.bodies.some((body) => body.kind === 'pool' || (body.vy ?? 0) !== 0), `seed ${seed}`).toBe(false);
    }
  });
});

describe('hra Skákačky z návrhu', () => {
  it('začátečník vyhraje 0,3–0,7, intermediate aspoň 0,8 (60 semínek)', () => {
    const spec = draftGameSpecWithMeta('a frog jumps across lily pads to reach the island', 1).spec;
    expect((spec.controlParams as { tuning?: { chunks?: number } }).tuning?.chunks).toBe(1);
    const wins = (profile: BotProfile) => {
      let won = 0;
      for (let seed = 1; seed <= 60; seed += 1) {
        const made = arcadeWorldOf(spec, seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        if (runBot(made.world, ARCADE_LIBRARY, { profile }).outcome === 'won') won += 1;
      }
      return won / 60;
    };
    const novice = wins('novice');
    expect(novice).toBeGreaterThanOrEqual(0.3);
    expect(novice).toBeLessThanOrEqual(0.7);
    expect(wins('intermediate')).toBeGreaterThanOrEqual(0.8);
  }, 300_000);
});
