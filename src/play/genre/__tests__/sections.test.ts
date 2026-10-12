/**
 * Běžec a skákačka z úseků (P36A T4): perfektní robot vyhraje za 30–90 s,
 * delší obsah věty („dodge 45 cars“ proti „dodge 20 cars“) dá delší běh, třetí
 * úsek je těžší než první a nečinný hráč prohraje.
 *
 * Co by vypadalo dobře a bylo špatně: trať je delší, ale každá věta stejně
 * dlouhá (počet z věty se zahodí); úseky existují, ale třetí je stejně řídký
 * a pomalý jako první; skákačka má hodiny, které robot nestihne, nebo žádné
 * a nečinný hráč stojí na startu věčně. Hra se tu staví stejnou cestou jako
 * z `/play` – rychlý návrh, semínka publikace, robot a nečinný hráč.
 */

import { describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { compileArcade } from '@/play/arcade/compile';
import { baseControlOf } from '@/play/arcade/addons';
import { ARCADE_HZ, type ArcadeRole, type ArcadeWorld, BODY, HEADER, type PieceRef, ROLE, bodyBase } from '@/play/arcade/contract';
import { type Phase, phaseSpeed } from '@/play/compose/progression';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { PLATFORM_DIFFICULTIES, checkPlatformLevel, platformLevel } from '@/play/arcade/pieces/platform';
import { RUNNER_DENSITIES, RUNNER_SPEEDS, SPEED, checkRunnerLevel, runnerTrack } from '@/play/arcade/pieces/runner';
import { draftGameSpecWithMeta, draftGenreFor } from '@/play/draft';
import { classifyGenre } from '@/play/genre/classify';
import { compileGenre } from '@/play/genre';
import type { GameSpecV1 } from '@/play/spec';

interface Published {
  readonly genre: string;
  readonly world: ArcadeWorld;
  readonly winSeconds: number;
  readonly idle: { readonly outcome: string; readonly seconds: number };
}

/** Jako dveře publikace: první semínko, na kterém robot vyhraje a nečinný hráč ne. */
function publish(sentence: string): Published {
  const spec = legacySpec(sentence);
  for (const seed of derivedSeeds(seedFrom(sentence))) {
    const compiled = compileArcade(spec, seed);
    if (!compiled.ok) continue;
    const { arcade: world, winsAtTick } = compiled.value;
    if (world == null || winsAtTick === null) continue;
    const idle = replay(world, [], ARCADE_LIBRARY);
    return { genre: spec.genre?.id ?? String(spec.control), world, winSeconds: winsAtTick / ARCADE_HZ, idle: { outcome: idle.outcome, seconds: idle.tick / ARCADE_HZ } };
  }
  throw new Error(`${sentence}: no seed publishes`);
}

interface Body {
  readonly role: ArcadeRole;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly h: number;
  readonly d: number;
}

const ROLE_NAME = Object.fromEntries(Object.entries(ROLE).map(([name, code]) => [code, name])) as Record<number, ArcadeRole>;

function bodies(world: ArcadeWorld): Body[] {
  const state = world.initial;
  return Array.from({ length: state[HEADER.bodyCount] as number }, (_, i) => {
    const base = bodyBase(i);
    const at = (slot: keyof typeof BODY): number => state[base + BODY[slot]] as number;
    return { role: ROLE_NAME[at('role')] as ArcadeRole, x: at('x'), y: at('y'), z: at('z'), h: at('h'), d: at('d') };
  });
}

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

const RUNNER_PAIRS = [
  ['run and dodge 20 cars', 'run and dodge 45 cars'],
  ['a corgi runs through the park and collects 10 bones', 'a corgi runs through the park and collects 50 bones'],
] as const;

describe('runner sections (P36A T4)', () => {
  it.each(RUNNER_PAIRS)('„%s“ and „%s“: the robot wins both in 30–90 s and the longer content runs longer', (short, long) => {
    const a = publish(short);
    const b = publish(long);
    for (const run of [a, b]) {
      expect(run.genre).toBe('runner');
      expect(run.winSeconds).toBeGreaterThanOrEqual(30);
      expect(run.winSeconds).toBeLessThanOrEqual(90);
      expect(run.idle.outcome).toBe('lost');
    }
    expect(b.winSeconds, `${String(a.winSeconds)} s vs ${String(b.winSeconds)} s`).toBeGreaterThan(a.winSeconds + 10);
  });

  it('the third section is faster and denser than the first', () => {
    const { world } = publish('run and dodge 45 cars');
    // Nová hra (P45C T11): rychlost dává křivka průběhu (`phase_control` pod `pacing_control`) místo rampy; úseky jsou třetiny trati.
    const phaseOf = (ref: PieceRef): PieceRef => (ref.id === 'phase_control' ? ref : phaseOf(ref.params.base as PieceRef));
    const { phases, length } = phaseOf(world.control).params as { phases: Phase[]; length: number };
    const speed = SPEED[baseControlOf(world.control).params.speed as keyof typeof SPEED];
    const speedAt = (z: number): number => phaseSpeed(speed, z, length, phases);
    const sectionOf = (z: number): number => Math.min(2, Math.floor((3 * z) / length));
    expect(speedAt(length - 1)).toBeGreaterThan(speedAt(0));

    const rows = new Map<number, number>();
    for (const body of bodies(world)) if (body.role === 'obstacle') rows.set(body.z, (rows.get(body.z) ?? 0) + 1);
    const zs = [...rows.keys()].sort((a, b) => a - b);
    // Odstup řady od předchozí v ticích běhu rychlostí jejího úseku a obsazené pruhy.
    const ticks = (section: number): number[] => zs.flatMap((z, i) => (i > 0 && sectionOf(z) === section && sectionOf(zs[i - 1]!) === section ? [(z - zs[i - 1]!) / speedAt(z)] : []));
    const lanes = (section: number): number[] => zs.filter((z) => sectionOf(z) === section).map((z) => rows.get(z)!);
    expect(ticks(0).length).toBeGreaterThan(2);
    expect(ticks(2).length).toBeGreaterThan(2);
    // Hustota v čase, ne jen zrychlení: samotná rampa +20 % by odstup v ticích zkrátila jen na 0,83×.
    expect(mean(ticks(2))).toBeLessThan(mean(ticks(0)) * 0.7);
    expect(mean(lanes(2))).toBeGreaterThanOrEqual(mean(lanes(0)) + 0.5);
  });

  it('runner sentences without a number do not all run the same length', () => {
    const times = ['endless runner in a neon city', 'a ninja running on rooftops sliding under laser beams', 'lava floor runner', 'a mouse runs through a kitchen dodging knives and pans', 'a hedgehog rolls down a mushroom hill avoiding foxes'].map((sentence) => publish(sentence).winSeconds);
    for (const seconds of times) {
      expect(seconds).toBeGreaterThanOrEqual(30);
      expect(seconds).toBeLessThanOrEqual(90);
    }
    expect(new Set(times).size, times.join(', ')).toBeGreaterThanOrEqual(3);
  });
});

describe('sectioned tracks stay playable by construction', () => {
  it('every runner speed and density and every platformer difficulty passes its level check on 12 seeds', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      for (const speed of RUNNER_SPEEDS) {
        for (const density of RUNNER_DENSITIES) {
          const params = runnerTrack.params.parse({ speed, density, sections: 3, rows: seed % 3 === 0 ? 50 : undefined });
          const level = runnerTrack.generate(seed * 7919, params);
          expect(checkRunnerLevel(level, speed), `${speed}/${density}/${String(seed)}`).toEqual([]);
          expect(level.sectionStarts).toHaveLength(2);
        }
      }
      for (const difficulty of PLATFORM_DIFFICULTIES) {
        const params = platformLevel.params.parse({ difficulty, checkpoints: true, sections: 3, movingPlatforms: seed % 2 === 0 });
        expect(checkPlatformLevel(platformLevel.generate(seed * 7919, params)), `${difficulty}/${String(seed)}`).toEqual([]);
      }
    }
  });
});

describe('a game stored before T4 (no `sections`) builds the world it had', () => {
  /** Spec, jak ho žánr zapsal před T4: bez `sections` v parametrech ovládání ani v `tuning` a bez `scoring` (to přišlo až s T5). */
  function storedBefore(sentence: string): GameSpecV1 {
    const spec = legacySpec(sentence);
    const { scoring: _scoring, ...unscored } = spec;
    const { sections: _sections, tuning, ...own } = spec.controlParams as Record<string, unknown> & { readonly sections?: number; readonly tuning?: Record<string, unknown> };
    const { sections: _inTuning, ...rest } = tuning ?? {};
    // Uložené hry nesou překlad žánru před průběhem P45C (`genre.v1`).
    const genre = unscored.genre === undefined ? {} : { genre: { ...unscored.genre, compilerVersion: 'genre.v1' } };
    return { ...unscored, ...genre, controlParams: { ...own, ...(tuning === undefined ? {} : { tuning: rest }) } } as GameSpecV1;
  }

  // Čísla z `evals/play/regression/report.json` před T4 (semínko 1): běžec 1522 tiků a 73 těl, skákačka 1701 tiků, 55 těl, 6 pravidel.
  it.each([
    ['Cross a frozen lake where the ice cracks under you every few seconds.', 1522, 73, 4],
    ['Cross floating islands; falling restarts at the last checkpoint.', 1701, 55, 6],
  ] as const)('„%s“ wins at tick %i with %i bodies and %i rules', (sentence, tick, entities, rules) => {
    const compiled = compileArcade(storedBefore(sentence), 1);
    if (!compiled.ok || compiled.value.arcade == null) throw new Error(`${sentence}: did not compile`);
    const world = compiled.value.arcade;
    expect(compiled.value.winsAtTick).toBe(tick);
    expect(world.initial[HEADER.bodyCount]).toBe(entities);
    expect(world.rules).toHaveLength(rules);
    expect(world.rules.some((rule) => rule.id === 'time_limit')).toBe(false);
  });
});

describe('platformer sections (P36A T4)', () => {
  const short = 'a frog jumps across lily pads to collect 3 flies';
  const long = 'a frog jumps across lily pads to collect 8 flies';

  it('the robot wins both in 30–90 s, the longer content runs longer and the idle player loses on the clock', () => {
    const a = publish(short);
    const b = publish(long);
    for (const run of [a, b]) {
      expect(run.genre).toBe('platformer');
      expect(run.winSeconds).toBeGreaterThanOrEqual(30);
      expect(run.winSeconds).toBeLessThanOrEqual(90);
      const limit = run.world.rules.find((rule) => rule.id === 'time_limit')?.params.seconds as number;
      // Hodiny robot stihne s rezervou; nečinný hráč na startu prohraje na nich, ne až na horizontu jádra.
      expect(limit).toBeGreaterThanOrEqual(run.winSeconds + 10);
      expect(run.idle.outcome).toBe('lost');
      expect(run.idle.seconds).toBeLessThan(90);
    }
    expect(b.winSeconds, `${String(a.winSeconds)} s vs ${String(b.winSeconds)} s`).toBeGreaterThan(a.winSeconds + 5);
  });

  it('three sections: a checkpoint opens the second and the third, which has wider gaps and more spikes than the first', () => {
    const sentence = 'a frog jumps across lily pads to reach the island';
    const { world } = publish(sentence);
    const list = bodies(world);
    const checkpoints = list.filter((body) => body.role === 'checkpoint').map((body) => body.z).sort((a, b) => a - b);
    // Úseky průběhu (P46B T6) mají checkpointů víc (i uprostřed úseků a v aréně): začátky úseků zná generátor.
    const { tuning, ...own } = legacySpec(sentence).controlParams as Record<string, unknown> & { tuning?: Record<string, unknown> };
    const starts = platformLevel.generate(world.seed, platformLevel.params.parse({ ...own, ...tuning })).sectionStarts ?? [];
    expect(starts).toHaveLength(2);
    for (const start of starts) expect(checkpoints).toContain(start + 800);
    const sectionOf = (z: number): number => (z >= starts[1]! ? 2 : z >= starts[0]! ? 1 : 0);
    const slabs = list.filter((body) => body.role === 'platform').sort((a, b) => a.z - b.z);
    const gaps = (section: number): number[] =>
      slabs.flatMap((slab, i) => {
        const prev = slabs[i - 1];
        if (prev === undefined || sectionOf(slab.z - slab.d / 2) !== section) return [];
        return [slab.z - slab.d / 2 - (prev.z + prev.d / 2)];
      });
    const spikes = (section: number): number => list.filter((body) => body.role === 'hazard' && sectionOf(body.z) === section).length;
    const platforms = (section: number): number => slabs.filter((slab) => sectionOf(slab.z - slab.d / 2) === section).length;
    expect(mean(gaps(2))).toBeGreaterThan(mean(gaps(0)));
    expect(spikes(2) / platforms(2)).toBeGreaterThan(spikes(0) / platforms(0));
  });
});

/** Frozen pre-P41 mechanics: routing to new movement families is tested separately. */
function legacySpec(sentence: string): GameSpecV1 {
  const pick = classifyGenre(sentence, null).ranked[0];
  const genre = draftGenreFor(sentence, pick.genre, pick.mode);
  if (genre === null) throw new Error(`missing legacy fixture: ${sentence}`);
  return compileGenre(genre);
}
