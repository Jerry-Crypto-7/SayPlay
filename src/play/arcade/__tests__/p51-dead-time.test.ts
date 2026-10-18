/**
 * Mrtvý čas nových her (P51 T7). Nejdelší mezera bez herní události (`longestGapS` telemetrie P45A, tatáž čísla
 * jako gauge P47A) na běhu robota `intermediate`: medián ≤ 4 s a žádný běh nad 6 s, hra pořád 30–90 s – mezera se
 * neřeší zkrácením hry. Brány jako `p51-walker-glide`: nečinný nevyhraje, přehrání = hash, intermediate ≥ 0,8 s
 * finále, novice ≥ 0,3 (horní mez 0,7 tam, kde ji hlídal test žánru už před T7).
 * - Chodec (živé buňky): jiskra tepu na cestě k východu a větší bludiště nové hry; uložená hra (bez značky nové hry,
 *   11 × 11) staví týž svět jako před T7.
 * - Běžec (živé buňky): tep pole P47A T9 na trati (`RUNNER_PULSE`); uložená `genre.v4` hra tep nemá.
 * - Střílečka (věty dev sady – živá buňka `shooter.default` má jeden život a průběh nedostane): pochod vln nikdy
 *   řidší než `SHOOTER_FOES.densityFloor`. Uložené `genre.v4` světy vět dev sady hlídá `p51-stored-v4.test.ts`.
 * Rytmus mezeru pod 4 s měl už před T7 (dev medián 3,62 s, nejdelší je náběh před první notou) – beze změny.
 */

import { createHash } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf, generatorOf } from '../compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, FLAG, HEADER, bodyBase, nativeRule } from '../contract';
import { loadRapier } from '../physics/world';
import { PACING, type PacingRuleParams } from '../pieces/pacing';
import { WALKER_BEAT, WALKER_CELL, WALKER_FINALE, walkerExit, walkerPath, type WalkerMap } from '../pieces/walker';
import { funMetrics, traceRun } from '../telemetry';
import { runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const cellsOf = (pattern: RegExp) => liveCells().filter((cell) => pattern.test(generatorOf(compileRecipe(assemblyOfCell(cell)))));
const WALKERS = cellsOf(/^walker_/);
const RUNNERS = cellsOf(/^runner_track$/);
const cellSpec = (id: string): GameSpecV1 => compileRecipe(assemblyOfCell(liveCells().find((cell) => cell.id === id)!));
/** Věty střílečky z dev sady P51 (`evals/play/p51/dev.json`). */
const SHOOTERS = [
  { id: 's01', text: 'a cowboy shoots tin cans off the fence at the ranch' },
  { id: 's02', text: 'an astronaut blasts asteroids heading for the space station' },
] as const;
/** Tatáž hra, jak ji uložila verze před P51: bez značky nové hry a s výchozím bludištěm 11 × 11. */
const storedOf = (spec: GameSpecV1): GameSpecV1 => {
  const { segments: _segments, ...params } = spec.controlParams as Record<string, unknown>;
  return { ...spec, controlParams: { ...params, size: 11 } as GameSpecV1['controlParams'] };
};
const storedV4Of = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v4' } });
const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
/** Otisk světa jako `p51-stored-v4` (fixtura `stored-v4-p51.json`). */
const worldPrint = (world: unknown): string => createHash('sha256').update(JSON.stringify(world)).digest('hex').slice(0, 16);
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
/** Živé jiskry na startu: tělesa druhu `spark` (stezka finále i jiskry cesty). */
const sparkCells = (world: ArcadeWorld, map: WalkerMap): number[] =>
  Array.from({ length: world.initial[HEADER.bodyCount]! }, (_, body) => body)
    .filter((body) => world.kinds[world.initial[bodyBase(body) + BODY.kind]!] === 'spark' && (world.initial[bodyBase(body) + BODY.flags]! & FLAG.alive) !== 0)
    .map((body) => Math.round(world.initial[bodyBase(body) + BODY.z]! / WALKER_CELL) * map.size + Math.round(world.initial[bodyBase(body) + BODY.x]! / WALKER_CELL));
const mapOf = (world: ArcadeWorld): WalkerMap & { readonly speed: number } => {
  let ref = world.control;
  while (ref.id !== 'walker') ref = ref.params.base as typeof ref;
  return ref.params as unknown as WalkerMap & { readonly speed: number };
};
const pulseOf = (world: ArcadeWorld): PacingRuleParams['pulse'] => (nativeRule(world.rules, 'pacing')?.params as PacingRuleParams | undefined)?.pulse;

/**
 * Brány mrtvého času na 12 semínkách: medián nejdelší mezery ≤ 4 s a žádná nad 6 s, běh 30–90 s, nečinný nevyhraje,
 * přehrání = hash, intermediate ≥ 0,8 a výhry s finále, novice ≥ 0,3 (s `noviceMax` i ≤ 0,7).
 */
function expectBusy(label: string, spec: GameSpecV1, noviceMax: boolean): void {
  const gaps: number[] = [];
  const seconds: number[] = [];
  let intermediate = 0;
  let finales = 0;
  let novice = 0;
  for (const seed of SEEDS) {
    const world = worldOf(spec, seed);
    const verdict = verifyArcade(world);
    expect(verdict.idle.outcome, `${label} seed ${seed}: idle`).not.toBe('won');
    expect(verdict.replayEqual, `${label} seed ${seed}: replay`).toBe(true);
    const bot = runBot(world, undefined, { profile: 'intermediate' });
    const trace = traceRun(world, bot.inputs);
    const metrics = funMetrics(trace);
    gaps.push(metrics.longestGapS);
    seconds.push(trace.ticks / ARCADE_HZ);
    if (bot.outcome === 'won') {
      intermediate += 1;
      if (metrics.finale.why !== null) finales += 1;
    }
    if (runBot(world, undefined, { profile: 'novice' }).outcome === 'won') novice += 1;
  }
  const runs = `gaps ${gaps.join(' ')}; runs ${seconds.map((s) => s.toFixed(1)).join(' ')}`;
  expect(median(gaps), `${label}: median longest gap (${runs})`).toBeLessThanOrEqual(4);
  expect(Math.max(...gaps), `${label}: longest gap (${runs})`).toBeLessThanOrEqual(6);
  expect(Math.min(...seconds), `${label}: shortest run (${runs})`).toBeGreaterThanOrEqual(30);
  expect(Math.max(...seconds), `${label}: longest run (${runs})`).toBeLessThanOrEqual(90);
  expect(intermediate / SEEDS.length, `${label}: intermediate (${runs})`).toBeGreaterThanOrEqual(0.8);
  expect(finales / intermediate, `${label}: finale in wins (${runs})`).toBeGreaterThanOrEqual(0.8);
  expect(novice / SEEDS.length, `${label}: novice`).toBeGreaterThanOrEqual(0.3);
  if (noviceMax) expect(novice / SEEDS.length, `${label}: novice`).toBeLessThanOrEqual(0.7);
}

/** Otisky uložených her (bez značky, 11 × 11) na semínkách 1–3, změřené na kódu před T7 (`ae07b7d9`). */
const STORED_PRINTS: Readonly<Record<string, readonly string[]>> = {
  'walk.reach': ['965ffed504f7eec1', 'c4bdf2251d01afe6', '80d196eff76a18ed'],
  'walk.collect': ['e21376f9a6bebc68', 'd549989d07626ce7', '3a1597bd76321f16'],
  'walk.reach+guard': ['8a15c0caf8525333', '55c77e126226ec02', '3e1e6ba85eef4b8f'],
  'walk.collect+guard': ['676afbfb94e7f9f6', 'c2a80ad72d268f43', '4574809ee7997460'],
  'walk.escape': ['705a6483c70facab', 'd8534a4d676c9a64', '92baff2524f1acff'],
  'walk.escape+collect': ['10c9c46ce000b061', '55c478028cec98da', '246f4bf0cbebe425'],
  'walk.escape+collect+guard': ['676afbfb94e7f9f6', 'c2a80ad72d268f43', '4574809ee7997460'],
};

beforeAll(async () => {
  await loadRapier();
});

describe('P51 T7: walker games stay busy', () => {
  it('covers the seven walker cells; the beat is the field heartbeat of P47A T9', () => {
    expect(WALKERS.map((cell) => cell.id).sort()).toEqual(Object.keys(STORED_PRINTS).sort());
    expect(WALKER_BEAT.beat).toBe(PACING.heartbeat);
  });

  for (const cell of WALKERS) {
    it(`${cell.id}: a new game has the big maze and a spark every beat of the route; a stored game builds the same world`, () => {
      const spec = cellSpec(cell.id);
      expect((spec.controlParams as { size?: number }).size).toBe(WALKER_BEAT.size);
      for (const seed of [1, 2, 3]) {
        const world = worldOf(spec, seed);
        const map = mapOf(world);
        const exit = walkerExit(map, true);
        const path = walkerPath(map, map.size + 1, exit);
        const step = Math.floor((WALKER_BEAT.beat * map.speed) / WALKER_CELL);
        const sparks = new Set(sparkCells(world, map));
        // Od startu nejvýš `step` polí cesty bez jiskry, až po stezku finále; jiskra jen na cestě, ne na startu ani ve východu.
        let since = 0;
        for (const at of path.slice(1, -1)) {
          since = sparks.has(at) ? 0 : since + 1;
          expect(since, `${cell.id} seed ${seed}: cell ${at}`).toBeLessThan(step);
        }
        expect([...sparks].every((at) => path.slice(1, -1).includes(at)), `seed ${seed}: sparks off the route`).toBe(true);
        expect(sparks.size, `seed ${seed}`).toBeGreaterThan(WALKER_FINALE.trail);
        expect(worldPrint(worldOf(storedOf(spec), seed)), `${cell.id} stored seed ${seed}`).toBe(STORED_PRINTS[cell.id]![seed - 1]);
      }
    });

    it(`${cell.id}: longest gap median ≤ 4 s and none over 6 s, runs 30–90 s; idle never wins, replay equal, intermediate ≥ 0.8 with a finale, novice 0.3–0.7`, () => {
      expectBusy(cell.id, cellSpec(cell.id), true);
    });
  }
});

describe('P51 T7: runner games get the field heartbeat', () => {
  it('covers the live runner cells; a new game has the heartbeat, a stored genre.v4 game does not', () => {
    expect(RUNNERS.length).toBeGreaterThanOrEqual(4);
    for (const cell of RUNNERS) {
      const spec = cellSpec(cell.id);
      expect(spec.genre?.compilerVersion, cell.id).toBe('genre.v5');
      expect(pulseOf(worldOf(spec))?.beat, cell.id).toBe(PACING.heartbeat);
      expect(pulseOf(worldOf(storedV4Of(spec))), cell.id).toBeUndefined();
    }
  });

  for (const cell of RUNNERS) {
    it(`${cell.id}: longest gap median ≤ 4 s and none over 6 s, runs 30–90 s; idle never wins, replay equal, intermediate ≥ 0.8 with a finale, novice ≥ 0.3`, () => {
      expectBusy(cell.id, cellSpec(cell.id), cell.id === 'runner.default');
    });
  }
});

describe('P51 T7: shooter waves march no sparser than the floor', () => {
  for (const { id, text } of SHOOTERS) {
    it(`${id}: longest gap median ≤ 4 s and none over 6 s, runs 30–90 s; idle never wins, replay equal, intermediate ≥ 0.8 with a finale, novice ≥ 0.3`, () => {
      const spec = draftGameSpecWithMeta(text, 1).spec;
      expect(generatorOf(spec), id).toBe('shooter_range');
      expect(spec.genre?.compilerVersion, id).toBe('genre.v5');
      expectBusy(id, spec, false);
    });
  }
});
