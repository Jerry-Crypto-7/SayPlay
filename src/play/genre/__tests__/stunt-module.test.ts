/**
 * Modul žánru Závod s triky (P68V T3): narážky jako seznam, meze parametrů, rychlý návrh z dev vět, překlad do hry
 * `stunt` (generátor `stunt_track`, robot `stunt_bot`) a publikační brána na 10 semínkách – robot vyhraje, nečinný ne,
 * dvě přehrání shodná. Viditelnost zůstává podle kostry P68-I: v registru `staged`, překlad hází („not live“), brány
 * `ROUTE_PENDING` a `DIRECTOR_PENDING` drží – klasifikátor hru s jejími skutečnými narážkami nevidí. Vzorek ručního
 * specu pro e2e (T5) je ve `stunt-evidence.json` a test drží, že je to přesně překlad modulu a projde bránou.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { arcadeReport, verifyArcade } from '../../arcade/verify';
import { arcadeWorldOf, compileArcade } from '../../arcade/compile';
import { ARCADE_LIBRARY } from '../../arcade/library';
import { modelOf } from '../../arcade/models';
import { loadRapier } from '../../arcade/physics/world';
import { STUNT, stuntControl } from '../../arcade/pieces/stunt';
import { stuntBot } from '../../arcade/pieces/stunt-bot';
import { compileWith } from '../../compose/compile';
import { DIRECTOR_PENDING } from '../../director/answer-schema';
import { type GameSpecV1, readGameSpec } from '../../spec';
import { ROUTE_PENDING, classifyGenre } from '../classify';
import type { GenreModule } from '../contract';
import { GENRE_MODULES, readGenreSpec } from '../index';
import { STUNT_CUES, STUNT_PARAM_BOUNDS, stuntGenre, stuntLiveGenre, vehicleOf } from '../stunt';

const LANE = join(process.cwd(), 'evals/play/p68/vozidla-sport');
const DEV = (JSON.parse(readFileSync(join(LANE, 'dev.json'), 'utf8')) as { sentences: { id: string; game: string; text: string }[] }).sentences.filter((row) => row.game === 'stunt');
const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);
const live = stuntLiveGenre as unknown as GenreModule;

/** Ruční hra e2e: monster truck skáče a bourá do beden v poušti. */
const CONTENT = { genre: 'stunt', mode: 'default', hero: 'monster truck', setting: 'desert', cast: [{ label: 'crate', does: 'avoid' }] } as const;

function specOf(content: object = CONTENT): GameSpecV1 {
  const read = readGenreSpec(content);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileWith(live, read.value);
}

beforeAll(async () => {
  await loadRapier();
});

describe('stunt genre module: wired by P68-I (T8)', () => {
  // P68-I T8 (zapojení, podle `integration.md` → „Požadované změny“ 1): registr nese hotový modul, klasifikátor hru
  // vidí; režisér a čtečka zůstávají za branou do placeného přenahrání P46E (plán P68-I, R5).
  it('the registry module is the live one: ready, compiling, the same cues, bounds and draft as the scaffold', () => {
    expect(GENRE_MODULES.stunt).toBe(stuntLiveGenre);
    expect(stuntLiveGenre.availability('default')).toBe('ready');
    expect(stuntGenre.cues).toBe(stuntLiveGenre.cues);
    expect(stuntGenre.paramBounds).toBe(stuntLiveGenre.paramBounds);
    expect(stuntGenre.draftFill).toBe(stuntLiveGenre.draftFill);
    expect(ROUTE_PENDING.has('stunt')).toBe(false);
    expect(DIRECTOR_PENDING.has('stunt')).toBe(true);
  });

  it('wired, the classifier puts stunt first on every one of its own dev sentences', () => {
    expect(DEV).toHaveLength(10);
    for (const { text } of DEV) expect(classifyGenre(text, null).ranked[0]?.genre, text).toBe('stunt');
  });

  it('cues are a list of stunt words – ramps, jumps, crashes – and never a plain race or drive (that is voyage)', () => {
    expect(STUNT_CUES).toEqual(expect.arrayContaining(['stunt', 'ramp', 'jump the', 'smash through', 'monster truck']));
    for (const plain of ['race', 'drive', 'ride', 'car', 'truck', 'drift']) expect(STUNT_CUES, plain).not.toContain(plain);
  });

  it('parameters: ramps 2–4, piles 2–4, length 200–360 m, difficulty 1–3; out of bounds is refused', () => {
    expect(STUNT_PARAM_BOUNDS).toEqual({ ramps: { min: 2, max: 4 }, piles: { min: 2, max: 4 }, lengthM: { min: 200, max: 360 }, difficulty: { min: 1, max: 3 } });
    expect(readGenreSpec({ ...CONTENT, params: { ramps: 4, piles: 2, lengthM: 360, difficulty: 3 } }).ok).toBe(true);
    for (const params of [{ ramps: 5 }, { piles: 1 }, { lengthM: 400 }, { difficulty: 0 }, { boxes: 4 }]) expect(readGenreSpec({ ...CONTENT, params }).ok, JSON.stringify(params)).toBe(false);
  });
});

describe('stunt draft from a sentence (T3)', () => {
  it('reads the vehicle, the thing in the piles and the place of every dev sentence', () => {
    const drafted = Object.fromEntries(DEV.map(({ id, text }) => {
      const fill = stuntGenre.draftFill(text, null);
      return [id, [fill.hero, fill.cast?.[0]?.label ?? null, fill.setting ?? null, fill.palette ?? null]];
    }));
    expect(drafted).toEqual({
      'v-s01': ['monster truck', 'crate', 'desert', 'desert'],
      'v-s02': ['police car', 'barrel', 'frozen lake', 'snow'],
      'v-s03': ['pizza delivery scooter', 'box', 'venice', null],
      'v-s04': ['red sports car', 'cone', 'canyon road', 'desert'],
      'v-s05': ['school bus', 'watermelon', 'county fair', null],
      'v-s06': ['dune buggy', 'tire', 'beach', 'beach'],
      'v-s07': ['tractor', 'fence', 'farm', 'meadow'],
      'v-s08': ['ice cream truck', 'crate', 'new york', null],
      'v-s09': ['garbage truck', 'trash can', 'city', 'city'],
      'v-s10': ['motorbike', 'old car', 'junkyard', 'factory'],
    });
    // Každé vozidlo dev vět má model katalogu.
    for (const { text } of DEV) expect(modelOf(stuntGenre.draftFill(text, null).hero as string, true), text).toBeDefined();
  });
});

describe('stunt compile (T3)', () => {
  it('turns the genre spec into a stunt game: stunt_track with the vehicle model, pile and finish roles, three lives', () => {
    const spec = specOf();
    expect(readGameSpec(JSON.parse(JSON.stringify(spec))).ok).toBe(true);
    expect(spec.control).toBe('stunt');
    expect(spec.genre).toEqual({ id: 'stunt', mode: 'default', compilerVersion: 'genre.v7' });
    expect(spec.controlParams).toEqual({ generator: 'stunt_track', tuning: { vehicle: 'gen3d-monster-truck' } });
    expect(spec.roles.map((role) => [role.id, role.kind, role.label])).toEqual([['player', 'player', 'monster truck'], ['pile', 'target', 'crate'], ['finish', 'exit', 'finish line']]);
    expect(spec.theme.look).toBe('desert');
    expect(spec.mechanics).toEqual([{ id: 'health', params: { max: 3 } }]);
    const tuned = specOf({ ...CONTENT, params: { ramps: 4, piles: 2, lengthM: 220, difficulty: 3 } });
    expect(tuned.controlParams).toEqual({ generator: 'stunt_track', tuning: { vehicle: 'gen3d-monster-truck', difficulty: 'hard', lengthM: 220, ramps: 4, piles: 2 } });
    expect(vehicleOf('school bus')).toBe(modelOf('school bus', true));
  });

  it('builds a world with the stunt control, its rules and bot, the vehicle as the player and Rapier crates from tick 0', () => {
    const made = arcadeWorldOf(specOf(), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const { world } = made;
    expect(world.control.id).toBe('stunt');
    expect(ARCADE_LIBRARY.controls.stunt).toBe(stuntControl);
    expect(world.bot.id).toBe('stunt_bot');
    expect(ARCADE_LIBRARY.bots.stunt_bot).toBe(stuntBot);
    expect(world.rules.map((rule) => rule.id)).toEqual(expect.arrayContaining(['finish', 'stunt_crash', 'stunt_impact', 'stunt_debris', 'out_of_health', 'time_limit']));
    expect(world.kinds).toContain('gen3d-monster-truck');
    expect((world.control.params as { ramps: unknown[] }).ramps).toHaveLength(STUNT.ramps.default);
    expect((world.control.params as { piles: number[] }).piles).toHaveLength(STUNT.piles.default);
  });
});

describe('stunt publication gate on 10 seeds (T3)', () => {
  const SPEC = specOf();

  it('compiles, the bot wins, the idle player does not, two replays agree – the report is publishable', () => {
    for (const seed of SEEDS) {
      const compiled = compileArcade(SPEC, seed);
      expect(compiled.ok, `seed ${String(seed)}: ${compiled.ok ? '' : compiled.issues.join('; ')}`).toBe(true);
      if (!compiled.ok) continue;
      const world = compiled.value.arcade;
      if (world === undefined) throw new Error('no arcade world');
      const verdict = verifyArcade(world);
      expect(verdict.failures, `seed ${String(seed)}`).toEqual([]);
      expect(verdict.bot.outcome).toBe('won');
      expect(verdict.idle.outcome).toBe('lost');
      expect(verdict.replayEqual).toBe(true);
      expect(arcadeReport(verdict, world, { specHash: compiled.value.specHash, worldHash: compiled.value.worldHash }).publishEligible, `seed ${String(seed)}`).toBe(true);
    }
  }, 300_000);

  it('the e2e fixture sample in stunt-evidence.json is exactly what the module compiles and passes the gate on its seed', () => {
    const { fixture } = JSON.parse(readFileSync(join(LANE, 'stunt-evidence.json'), 'utf8')) as { fixture: { seed: number; spec: unknown } };
    expect(fixture.spec).toEqual(JSON.parse(JSON.stringify(SPEC)));
    const read = readGameSpec(fixture.spec);
    expect(read.ok).toBe(true);
    const compiled = compileArcade(SPEC, fixture.seed);
    expect(compiled.ok).toBe(true);
    if (compiled.ok && compiled.value.arcade !== undefined) {
      expect(verifyArcade(compiled.value.arcade).publishEligible).toBe(true);
      expect(canonicalHash(SPEC)).toBe(compiled.value.specHash);
    }
  }, 120_000);
});
