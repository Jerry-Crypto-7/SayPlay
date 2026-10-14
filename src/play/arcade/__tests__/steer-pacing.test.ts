/**
 * Řízení s úseky a bossem (P46B T5): nová hra řízení (`compose/drive.ts`, značka `segments`) má rozjezd s turby, v
 * úseku 2 nového soupeře (shazovač), trať užší a rychlejší po úsecích a ve finále bosse-pronásledovatele, který
 * shazuje do trati překážky po varování aspoň `TELEGRAPH_MIN` tiků. Výhru nedá – hra se dál vyhrává cílem. Uložená
 * hra (bez značky, `genre.v1`) staví tentýž svět jako dřív. Obtížnost hlídá jen robot, proto ji test měří na živých
 * buňkách řízení (brány beze ztrát, vzor `runner-boss.test.ts`).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createCompileRng } from '@/play/compile/rng';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { GENRE_COMPILER_VERSION } from '@/play/genre/contract';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import steerFixture from '../__fixtures__/steer.json';
import { arcadeWorldOf } from '../compile';
import { type ArcadeEffect, type ArcadeWorld, BODY, FLAG, HEADER, type InputEvent, type PieceRef, ROLE, bodyBase, nativeRule } from '../contract';
import { instantiate, replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { TELEGRAPH_MIN, behaviourBodies, behaviourPhaseOf } from '../pieces/behaviours';
import { play, refsOf } from '../pieces/behaviours/__tests__/harness';
import { PACING, type PacingRuleParams, segmentWidths } from '../pieces/pacing';
import { GENRE_PACING, STEER_FOES } from '../pieces/pacing-parts';
import { segmentScriptOf, segmentSpans } from '../pieces/segments';
import { STEER_TRACK, steerTrack } from '../pieces/steer';
import { funMetrics, traceRun } from '../telemetry';
import { runBot } from '../verify';
import { segmentRun } from '../../../../evals/play/p46b/segments';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);
const DRIVE = liveCells().filter((cell) => cell.assembly === 'drive');
const specOf = (id: string): GameSpecV1 => compileRecipe(assemblyOfCell(DRIVE.find((cell) => cell.id === id)!));

function worldOf(spec: GameSpecV1, seed = 1): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Kus `id` v řetězu obalů (`params.base`). */
function pieceIn(ref: PieceRef, id: string): PieceRef | undefined {
  if (ref.id === id) return ref;
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? undefined : pieceIn(base, id);
}

const withoutMark = (spec: GameSpecV1): GameSpecV1 => {
  const { segments: _segments, ...params } = spec.controlParams as Record<string, unknown>;
  return { ...spec, controlParams: params };
};

const read = (raw: unknown): GameSpecV1 => {
  const spec = readGameSpec(raw);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  return spec.value;
};

/**
 * Šířka silnice rozjezdu a úseků 2 a 3 (mantinely generátoru, bez natažení fází): ta, která v úseku vede nejdelší kus
 * trati (`segmentWidths` – okruh ze vzorů P46D má v úseku i zúžení a rozcestí).
 */
function widthsOf(spec: GameSpecV1, seed: number): number[] {
  return segmentWidths(steerTrack.generate(seed, steerTrack.params.parse(spec.controlParams)));
}

interface SteerRun {
  readonly end: number;
  /** Zásahy bosse, tik, kdy zmizel (−1 = do konce ne). */
  readonly hits: number;
  readonly gone: number;
  /** Tiky varování před každým shozem (všech shazovačů) a kolik shozů bylo. */
  readonly warnings: readonly number[];
  readonly drops: number;
}

/** Přehraje vstupy: boss (předloha poslední), jeho zásahy a zmizení, a varování před každým shozem. */
function steerRun(world: ArcadeWorld, inputs: readonly InputEvent[]): SteerRun {
  const refs = refsOf(world);
  const boss = refs[refs.length - 1]!;
  const shot = boss.shot;
  let body = -1;
  let gone = -1;
  let end = 0;
  let hits = 0;
  let drops = 0;
  const warned = new Map<number, number>();
  const warnings: number[] = [];
  play(world, inputs, (state, tick, effects: readonly ArcadeEffect[]) => {
    end = tick;
    const player = state[HEADER.player] as number;
    for (const dropper of behaviourBodies(state, player, refs)) {
      const phase = behaviourPhaseOf(state, dropper);
      if (phase === 'telegraph') warned.set(dropper, (warned.get(dropper) ?? 0) + 1);
      else if (phase === 'act' && warned.has(dropper)) {
        warnings.push(warned.get(dropper) as number);
        warned.delete(dropper);
      } else warned.delete(dropper);
    }
    drops += effects.filter((effect) => effect.kind === 'spawn' && effect.template === shot).length;
    if (body < 0) {
      const same = (b: number, slot: number): boolean => state[bodyBase(b) + slot] === state[bodyBase(boss.template) + slot];
      for (let b = state[HEADER.spawnBase] as number; b < (state[HEADER.bodyCount] as number); b += 1) {
        if (((state[bodyBase(b) + BODY.flags] as number) & FLAG.alive) !== 0 && same(b, BODY.kind) && same(b, BODY.w)) body = b;
      }
      // Slot mohl v témže tiku uvolnit úklid soupeřů: zásahy a zmizení až od dalšího tiku.
      return;
    }
    if (gone >= 0) return;
    hits += effects.filter((effect) => effect.kind === 'hit' && effect.body === body).length;
    if (effects.some((effect) => effect.kind === 'despawn' && effect.body === body)) gone = tick;
  });
  return { end, hits, gone, warnings, drops };
}

const STORED_ENTRY = GENRE_PACING.steer_track;
const STEER_ENTRY = STORED_ENTRY!;
afterEach(() => {
  GENRE_PACING.steer_track = STORED_ENTRY;
});

describe('steer pacing', () => {
  it('paces a new drive game: segment foe from segment 2, a bigger pursuer boss last, foes cleared with it, no boss rule that could win', () => {
    const spec = specOf('drive.reach');
    expect(spec.controlParams).toMatchObject({ segments: true });
    const world = worldOf(spec);
    const rule = nativeRule(world.rules, 'pacing')?.params as PacingRuleParams;
    expect(rule.finale).toBe('boss');
    const refs = refsOf(world);
    expect(refs.map((ref) => ref.id)).toEqual(['dropper', 'dropper']);
    const [scout, boss] = refs as [(typeof refs)[number], (typeof refs)[number]];
    const initial = instantiate(world);
    expect(world.kinds[initial[bodyBase(boss.template) + BODY.kind] as number]).toBe('boss');
    expect(initial[bodyBase(boss.template) + BODY.w]).toBeGreaterThan(initial[bodyBase(scout.template) + BODY.w] as number);
    const scouts = rule.schedule.filter((entry) => entry.template === scout.template);
    expect(scouts.length).toBeGreaterThanOrEqual(4);
    for (const entry of scouts) expect(entry.atPermille).toBeGreaterThanOrEqual(STEER_FOES.from);
    for (const entry of scouts) expect(entry.atPermille).toBeLessThan(STEER_FOES.bossAt);
    expect(rule.schedule.find((entry) => entry.template === boss.template)?.atPermille).toBe(STEER_FOES.bossAt);
    expect(rule.clear).toEqual([{ role: ROLE.hazard, at: STEER_FOES.bossAt }]);
    // Výhru dává jen cíl: boss nemá pravidlo zásahu ani výhry.
    expect(nativeRule(world.rules, 'boss_beat')).toBeUndefined();
    expect(pieceIn(world.bot, 'steer_bot')?.params).toMatchObject({ dodge: true });
  });

  it('leaves a stored steer game exactly as it was – without the mark, as genre.v1, and the old fixture – and paces a genre game', () => {
    const stored = withoutMark(specOf('drive.race'));
    const before = worldOf(stored);
    expect(nativeRule(before.rules, 'pacing')).toBeUndefined();
    const v1 = { ...stored, genre: { id: 'voyage', mode: 'race', compilerVersion: 'genre.v1' } } as GameSpecV1;
    expect(nativeRule(worldOf(read(v1)).rules, 'pacing')).toBeUndefined();
    expect(nativeRule(worldOf(read(steerFixture)).rules, 'pacing')).toBeUndefined();
    // Bez záznamu žánru staví stejný svět: brána nepustila uložené hry k záznamu vůbec.
    delete GENRE_PACING.steer_track;
    expect(worldOf(stored)).toEqual(before);
    GENRE_PACING.steer_track = STORED_ENTRY;
    // Spec žánru (ne `genre.v1`) se generátorem `steer_track` průběh dostane i bez značky.
    const genre = read({ ...v1, genre: { id: 'voyage', mode: 'race', compilerVersion: GENRE_COMPILER_VERSION } });
    expect(nativeRule(worldOf(genre).rules, 'pacing')?.params).toMatchObject({ finale: 'boss' });
  });

  it('builds a drive with parts (P42) as before: no mark, no pacing, no paced road and no dodging bot', () => {
    const content = { genre: 'voyage', mode: 'race', hero: 'seal', setting: 'snow' } as const;
    const parted = compileRecipe({ preset: 'assembled', move: 'drive', actions: [], objective: 'reach', threats: [], content, parts: [{ kind: 'catch', role: 'part_0', label: 'fish', phase: 0, motion: 'fall' }] });
    expect(parted.controlParams).not.toHaveProperty('segments');
    const world = worldOf(parted);
    expect(nativeRule(world.rules, 'pacing')).toBeUndefined();
    expect(pieceIn(world.bot, 'steer_bot')?.params).not.toHaveProperty('dodge');
    // Bez dílů je to nová hra řízení: značku nese.
    expect(compileRecipe({ preset: 'assembled', move: 'drive', actions: [], objective: 'reach', threats: [], content, parts: [] }).controlParams).toMatchObject({ segments: true });
  });

  it('gives a track too full for the foes only the curve and a sprint finale – the game never fails because of pacing', () => {
    const spec = specOf('drive.reach');
    const params = steerTrack.params.parse(spec.controlParams);
    const level = steerTrack.generate(1, params);
    const full = { ...level, bodies: [...level.bodies, ...Array.from({ length: 256 - level.bodies.length - STEER_FOES.room }, () => ({ ...level.bodies[0]!, role: 'collectible' as const, kind: 'turbo', z: 1, template: true }))] };
    const setup = STEER_ENTRY(({ control: { id: 'steer', params: {} }, bot: { id: 'steer_bot', params: {} }, level: full, rules: [] }), spec, 1)!;
    expect(setup).toMatchObject({ finale: 'sprint', behaviours: [], budget: 0, segments: 'steer' });
    expect(setup.boss).toBeUndefined();
    const roomy = STEER_ENTRY(({ control: { id: 'steer', params: {} }, bot: { id: 'steer_bot', params: {} }, level, rules: [] }), spec, 1)!;
    expect(roomy).toMatchObject({ finale: 'boss', boss: { at: STEER_FOES.bossAt, behaviour: 'dropper' } });
  });

  it('scripts three segments: a new rival, a narrower and faster track in segment 2, narrower and faster again in segment 3', () => {
    // Generátor zužuje na koncích úseků průběhu (`pacing.ts` nečte, kopie hranic).
    expect(STEER_TRACK.segmentEnds).toEqual([PACING.segments.intro, PACING.segments.buildUp]);
    const spec = specOf('drive.race');
    for (const seed of [1, 2, 3]) {
      const widths = widthsOf(spec, seed);
      // Každý úsek o ≥ 10 % užší než předchozí (měřidlo T1 počítá změnu šířky od 10 %).
      expect(widths[1]! * 11, `seed ${seed}: ${widths.join('/')}`).toBeLessThanOrEqual(widths[0]! * 10);
      expect(widths[2]! * 11, `seed ${seed}: ${widths.join('/')}`).toBeLessThanOrEqual(widths[1]! * 10);
      const phases = pieceIn(worldOf(spec, seed).control, 'phase_control')?.params.phases as { start: number; speedPercent: number }[];
      const speeds = [0, ...segmentSpans().map(([at]) => at)].map((at) => [...phases].reverse().find((phase) => phase.start <= at)!.speedPercent);
      expect(speeds[1]! * 10).toBeGreaterThanOrEqual(speeds[0]! * 11);
      expect(speeds[2]! * 10).toBeGreaterThanOrEqual(speeds[1]! * 11);
      const script = segmentScriptOf(createCompileRng(seed, 'pacing'), 'steer', { foes: [{ behaviour: 'dropper', from: STEER_FOES.from }], speeds, widths });
      expect(script[0]!.changes).toEqual([{ kind: 'speedTier', percent: speeds[1] }, { kind: 'newFoe', behaviour: 'dropper' }, { kind: 'terrain', variant: 'narrow' }]);
      expect(script[1]!.changes).toEqual([{ kind: 'speedTier', percent: speeds[2] }, { kind: 'terrain', variant: 'narrow' }]);
    }
    // Měřidlo T1 to vidí i ve hře: oba úseky přinesou hratelnou změnu, úsek 2 nového nepřítele.
    const world = worldOf(spec);
    const run = segmentRun(world, runBot(world, undefined, { profile: 'intermediate' }).inputs);
    expect(run.segmentChanges).toBe(2);
    expect(run.changes[0]!.some((change) => change.startsWith('foe:hazard'))).toBe(true);
  });

  it.each(DRIVE.map((cell) => cell.id))('keeps %s lossless with the boss: playable, idle never wins, replay exact, novice 0.3–0.7, intermediate ≥ 0.8 and every win beats the boss before the finish; rising, dead time ≤ 4 s, warnings ≥ TELEGRAPH_MIN', (id) => {
    const spec = specOf(id);
    const wins = { bot: 0, novice: 0, intermediate: 0 };
    const gaps: number[] = [];
    let rising = 0;
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      expect(replay(world, [], ARCADE_LIBRARY).outcome, `${id}/${seed}: idle`).not.toBe('won');
      if (wins.bot === 0 && runBot(world).outcome === 'won') wins.bot += 1;
      if (runBot(world, undefined, { profile: 'novice' }).outcome === 'won') wins.novice += 1;
      const run = runBot(world, undefined, { profile: 'intermediate' });
      const trace = traceRun(world, run.inputs);
      expect(trace.hash, `${id}/${seed}: replay`).toBe(run.hash);
      const metrics = funMetrics(trace);
      gaps.push(metrics.longestGapS);
      if (metrics.rising) rising += 1;
      const steer = steerRun(world, run.inputs);
      expect(steer.drops, `${id}/${seed}: drops`).toBeGreaterThan(0);
      for (const warned of steer.warnings) expect(warned, `${id}/${seed}: warning`).toBeGreaterThanOrEqual(TELEGRAPH_MIN);
      if (run.outcome !== 'won') continue;
      wins.intermediate += 1;
      // Finále: boss s ≥ 3 zásahy, který do cíle zmizí (měřidlo P45A), a výhru přinesl až cíl.
      expect(steer.hits, `${id}/${seed}: boss hits`).toBeGreaterThanOrEqual(3);
      expect(steer.gone, `${id}/${seed}: boss gone`).toBeGreaterThan(0);
      expect(steer.gone, `${id}/${seed}: boss falls before the finish`).toBeLessThan(steer.end);
      expect(metrics.finale.why).toBe('boss');
      expect(trace.outcome).toBe('won');
      expect(run.tick).toBeGreaterThan(steer.gone);
    }
    expect(wins.bot, `${id}: playable`).toBe(1);
    expect(wins.intermediate / SEEDS.length, `${id}: intermediate`).toBeGreaterThanOrEqual(0.8);
    expect(wins.novice / SEEDS.length, `${id}: novice`).toBeGreaterThanOrEqual(0.3);
    expect(wins.novice / SEEDS.length, `${id}: novice`).toBeLessThanOrEqual(0.7);
    expect(rising / SEEDS.length, `${id}: rising`).toBeGreaterThanOrEqual(0.7);
    const sorted = [...gaps].sort((a, b) => a - b);
    expect((sorted[4]! + sorted[5]!) / 2, `${id}: dead time median ${sorted.join(',')}`).toBeLessThanOrEqual(4);
  }, 600_000);
});
