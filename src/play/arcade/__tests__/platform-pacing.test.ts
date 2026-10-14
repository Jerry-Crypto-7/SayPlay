/**
 * Skákačka s úseky a bossem (P46B T6): nová hra skákačky (žánr Skákačka, značka `segments`) má rozjezd, v úseku 2
 * novou past (hrot, který vyjíždí ze země) a pohyblivou plošinu, úsek 3 rychlejší a na konci arénu s bossem, kterého
 * jde porazit jen skokem na hlavu (3 zásahy) a který výhru nedá – hra se dál vyhrává cílem. Robot plánuje skoky
 * rychlostí úseku. Uložená hra (bez značky, `genre.v1`, fixtura) a hra s jedním životem staví tentýž svět jako dřív.
 * Obtížnost hlídá jen robot, proto ji test měří na živých buňkách skákačky (vzor `steer-pacing.test.ts`).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createCompileRng } from '@/play/compile/rng';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { GENRE_COMPILER_VERSION } from '@/play/genre/contract';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import platformFixture from '../__fixtures__/platform.json';
import { arcadeWorldOf, generatorOf } from '../compile';
import { type ArcadeEffect, type ArcadeWorld, BODY, FLAG, HEADER, type InputEvent, type PieceRef, ROLE, bodyBase, nativeRule } from '../contract';
import { instantiate, replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { BEHAVIOURS, TELEGRAPH_MIN, behaviourBodies, behaviourPhaseOf } from '../pieces/behaviours';
import { play, refsOf } from '../pieces/behaviours/__tests__/harness';
import { BRUTE } from '../pieces/behaviours/brute';
import { PACING, type PacingRuleParams } from '../pieces/pacing';
import { GENRE_PACING, PLATFORM_FOES } from '../pieces/pacing-parts';
import { PLATFORM, PLATFORM_JUMP_PEAK, PLATFORM_SEGMENTS, checkPlatformLevel, platformLevel } from '../pieces/platform';
import { segmentScriptOf, segmentSpans } from '../pieces/segments';
import { funMetrics, traceRun } from '../telemetry';
import { runBot } from '../verify';
import { segmentRun } from '../../../../evals/play/p46b/segments';

const SEEDS = Array.from({ length: 8 }, (_, index) => index + 1);
const specOfCell = (id: string): GameSpecV1 => compileRecipe(assemblyOfCell(liveCells().find((cell) => cell.id === id)!));
/** Živé buňky skákačky, které průběh dostanou (`jump.escape` má jeden život). */
const PACED = liveCells().filter((cell) => cell.id.startsWith('platformer.') && generatorOf(specOfCell(cell.id)) === 'platform_level');

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

const tuningOf = (spec: GameSpecV1): Record<string, unknown> => ((spec.controlParams as { tuning?: Record<string, unknown> }).tuning ?? {});
const withoutMark = (spec: GameSpecV1): GameSpecV1 => {
  const { segments: _segments, ...tuning } = tuningOf(spec);
  return { ...spec, controlParams: { ...spec.controlParams, tuning } };
};
const read = (raw: unknown): GameSpecV1 => {
  const spec = readGameSpec(raw);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  return spec.value;
};

interface BossRun {
  readonly end: number;
  /** Zásahy bosse, kolik z nich bez hráče na jeho hlavě, tik, kdy zmizel (−1 = do konce ne). */
  readonly hits: number;
  readonly offHead: number;
  readonly gone: number;
  /** Tik posledního zásahu. */
  readonly lastHit: number;
  /** Tiky varování před každým náběhem. */
  readonly warnings: readonly number[];
  /** Odkud hráč na hlavu skočil: výška poslední země mimo hlavu bosse nad dnem jámy, u každého zásahu. */
  readonly takeoffs: readonly number[];
}

/** Přehraje vstupy a sleduje bosse (jediná předloha chování): zásahy, kde u nich stál hráč, zmizení a varování. */
function bossRun(world: ArcadeWorld, inputs: readonly InputEvent[]): BossRun {
  const refs = refsOf(world);
  let body = -1;
  let gone = -1;
  let end = 0;
  let hits = 0;
  let offHead = 0;
  let lastHit = -1;
  let warned = 0;
  const warnings: number[] = [];
  let ground = 0;
  const takeoffs: number[] = [];
  play(world, inputs, (state, tick, effects: readonly ArcadeEffect[]) => {
    end = tick;
    const player = state[HEADER.player] as number;
    const live = behaviourBodies(state, player, refs);
    if (body < 0 && live.length > 0) body = live[0] as number;
    if (body < 0 || gone >= 0) return;
    const phase = behaviourPhaseOf(state, body);
    if (phase === 'telegraph') warned += 1;
    else if (warned > 0) {
      if (phase === 'act') warnings.push(warned);
      warned = 0;
    }
    const at = (b: number, slot: keyof typeof BODY): number => state[bodyBase(b) + BODY[slot]] as number;
    if ((at(player, 'flags') & FLAG.grounded) !== 0 && at(player, 'y') !== at(body, 'y') + at(body, 'h')) ground = at(player, 'y');
    for (const effect of effects) {
      if (effect.kind !== 'hit' || effect.body !== body) continue;
      hits += 1;
      lastHit = tick;
      takeoffs.push(ground - at(body, 'y'));
      const standing = ((at(player, 'flags') & FLAG.grounded) !== 0) && at(player, 'y') === at(body, 'y') + at(body, 'h') && Math.abs(at(player, 'z') - at(body, 'z')) * 2 < at(player, 'd') + at(body, 'd');
      if (!standing) offHead += 1;
    }
    if (effects.some((effect) => effect.kind === 'despawn' && effect.body === body)) gone = tick;
  });
  return { end, hits, offHead, gone, lastHit, warnings, takeoffs };
}

const STORED_ENTRY = GENRE_PACING.platform_level;
afterEach(() => {
  GENRE_PACING.platform_level = STORED_ENTRY;
});

describe('platform pacing', () => {
  it('paces a new platformer: speed of the segment for control and bot, a solid boss in the arena last, no boss rule that could win', () => {
    expect(PACED.map((cell) => cell.id).sort()).toEqual(['platformer.default', 'platformer.default+chase_me', 'platformer.default+chase_me+shoot_at', 'platformer.default+shoot_at']);
    const spec = specOfCell('platformer.default');
    expect(tuningOf(spec)).toMatchObject({ segments: true });
    const world = worldOf(spec);
    const rule = nativeRule(world.rules, 'pacing')?.params as PacingRuleParams;
    expect(rule.finale).toBe('boss');
    const refs = refsOf(world);
    expect(refs.map((ref) => ref.id)).toEqual(['brute']);
    const boss = refs[0]!;
    const initial = instantiate(world);
    const slot = (name: keyof typeof BODY): number => initial[bodyBase(boss.template) + BODY[name]] as number;
    expect(world.kinds[slot('kind')]).toBe('boss');
    expect(slot('role')).toBe(ROLE.hazard);
    expect(slot('flags') & FLAG.solid).not.toBe(0);
    expect(rule.schedule).toEqual([{ atPermille: PLATFORM_FOES.bossAt, template: boss.template, count: 1, entry: 0 }]);
    // Výhru dává jen cíl: boss nemá pravidlo zásahu ani výhry.
    expect(nativeRule(world.rules, 'boss_beat')).toBeUndefined();
    // Fáze škálují nejvyšší rychlost běhu ovládání i robota (robot skáče rychlostí úseku).
    const phases = pieceIn(world.control, 'phase_control')?.params.phases as { start: number; speedPercent: number }[];
    expect(phases.map((phase) => phase.speedPercent)).toEqual([...PLATFORM_FOES.speeds]);
    expect(pieceIn(world.control, 'platform')?.params).toMatchObject({ speed: PLATFORM.maxRun });
    expect(pieceIn(world.bot, 'platform_bot')?.params).toMatchObject({ speed: PLATFORM.maxRun });
    expect(pieceIn(world.bot, 'phase_bot')).toBeDefined();
  });

  it('leaves stored platform games exactly as they were – without the mark, as genre.v1, the old fixture, and the one-life escape', () => {
    const stored = withoutMark(specOfCell('platformer.default'));
    const before = worldOf(stored);
    expect(nativeRule(before.rules, 'pacing')).toBeUndefined();
    const v1 = { ...stored, genre: { id: 'platformer', mode: 'default', compilerVersion: 'genre.v1' } } as GameSpecV1;
    expect(nativeRule(worldOf(read({ ...v1, controlParams: specOfCell('platformer.default').controlParams })).rules, 'pacing')).toBeUndefined();
    expect(nativeRule(worldOf(read(platformFixture)).rules, 'pacing')).toBeUndefined();
    // Bez záznamu žánru staví stejný svět: uložená hra se k záznamu nedostala vůbec.
    delete GENRE_PACING.platform_level;
    expect(worldOf(stored)).toEqual(before);
    GENRE_PACING.platform_level = STORED_ENTRY;
    // Útěk s jedním životem: bez značky i bez průběhu.
    const escape = specOfCell('jump.escape');
    expect(tuningOf(escape).segments).toBeUndefined();
    expect(nativeRule(worldOf(escape).rules, 'pacing')).toBeUndefined();
    // Spec žánru se značkou (ne `genre.v1`) průběh dostane.
    const genre = read({ ...v1, genre: { id: 'platformer', mode: 'default', compilerVersion: GENRE_COMPILER_VERSION }, controlParams: specOfCell('platformer.default').controlParams });
    expect(nativeRule(worldOf(genre).rules, 'pacing')?.params).toMatchObject({ finale: 'boss' });
  });

  it('scripts the segments: a new trap and a moving platform in segment 2, a faster segment 3 – and the T1 gauge sees both', () => {
    const spec = specOfCell('platformer.default');
    const { tuning, ...own } = spec.controlParams as Record<string, unknown> & { tuning?: Record<string, unknown> };
    for (const seed of SEEDS) {
      // Hratelná z konstrukce i s pastí, kratší mezerou pohyblivé plošiny a arénou.
      expect(checkPlatformLevel(platformLevel.generate(seed, platformLevel.params.parse({ ...own, ...tuning }))), `seed ${seed}`).toEqual([]);
      const world = worldOf(spec, seed);
      const initial = instantiate(world);
      const permille = (body: number): number => Math.floor(((initial[bodyBase(body) + BODY.z] as number) * 1000) / world.length);
      const moving = (role: number): number[] => Array.from({ length: initial[HEADER.bodyCount] as number }, (_, body) => body).filter((body) => {
        const base = bodyBase(body);
        return initial[base + BODY.role] === role && ((initial[base + BODY.flags] as number) & (FLAG.kinematic | FLAG.alive)) === (FLAG.kinematic | FLAG.alive);
      });
      // Past a pohyblivá plošina jen v úseku 2 za zorným polem rozjezdu (`trapFrom`), nikde jinde.
      const traps = moving(ROLE.hazard).map(permille);
      const shuttles = moving(ROLE.platform).map(permille);
      expect(traps.length, `seed ${seed}: traps`).toBeGreaterThan(0);
      expect(shuttles.length, `seed ${seed}: shuttles`).toBe(1);
      for (const at of [...traps, ...shuttles]) {
        expect(at, `seed ${seed}`).toBeGreaterThanOrEqual(PLATFORM_SEGMENTS.trapFrom);
        expect(at, `seed ${seed}`).toBeLessThan(PACING.segments.buildUp);
      }
      const phases = pieceIn(world.control, 'phase_control')?.params.phases as { start: number; speedPercent: number }[];
      const speeds = [0, ...segmentSpans().map(([at]) => at)].map((at) => [...phases].reverse().find((phase) => phase.start <= at)!.speedPercent);
      const script = segmentScriptOf(createCompileRng(seed, 'pacing'), 'platform', { foes: [], speeds, places: [[], ['trap', 'moving'], []] });
      expect(script[0]!.changes).toEqual([{ kind: 'speedTier', percent: speeds[1] }, { kind: 'terrain', variant: 'trap' }, { kind: 'terrain', variant: 'moving' }]);
      expect(script[1]!.changes).toEqual([{ kind: 'speedTier', percent: speeds[2] }]);
      expect(speeds[2]! * 10).toBeGreaterThanOrEqual(speeds[1]! * 11);
    }
    // Měřidlo T1: úsek 2 přinese novou hrozbu (pohyblivý hrot) a pohyblivou plošinu, úsek 3 rychlost.
    const world = worldOf(spec);
    const run = segmentRun(world, runBot(world, undefined, { profile: 'intermediate' }).inputs);
    expect(run.segmentChanges).toBe(2);
    expect(run.changes[0]).toEqual(expect.arrayContaining(['foe:hazard:roam', 'terrain:platform:moving']));
    expect(run.changes[1]!.some((change) => change.startsWith('speed:'))).toBe(true);
  });

  it('ends in a boss pit: the boss stands twice the hero tall, its head is out of reach from the floor and the step, and only the ledge above the pit reaches it', () => {
    const boss = BEHAVIOURS.brute.body;
    expect(boss.h).toBeGreaterThanOrEqual(2 * PLATFORM.playerH);
    expect(boss.h).toBeGreaterThan(boss.w);
    expect(boss.h).toBeGreaterThan(boss.d);
    const spec = specOfCell('platformer.default');
    const { tuning, ...own } = spec.controlParams as Record<string, unknown> & { tuning?: Record<string, unknown> };
    for (const seed of SEEDS) {
      const level = platformLevel.generate(seed, platformLevel.params.parse({ ...own, ...tuning }));
      const slabs = level.bodies.filter((body) => body.role === 'platform' && body.kinematic !== true).map((body) => ({ near: body.z - body.d / 2, far: body.z + body.d / 2, top: body.y + body.h })).sort((a, b) => a.near - b.near);
      const goal = level.bodies.find((body) => body.role === 'goal')!;
      const [step, ledge, pit] = slabs.slice(-3) as [(typeof slabs)[0], (typeof slabs)[0], (typeof slabs)[0]];
      expect(goal.y, `seed ${seed}: goal on the pit floor`).toBe(pit.top);
      expect(goal.z).toBeGreaterThan(pit.near);
      expect(ledge.far, `seed ${seed}: the pit opens under the ledge`).toBe(pit.near);
      expect(ledge.top - pit.top).toBe(PLATFORM_SEGMENTS.pit);
      expect(step.top - pit.top).toBe(PLATFORM_SEGMENTS.pit / 2);
      const head = pit.top + boss.h;
      expect(head - pit.top, `seed ${seed}: floor`).toBeGreaterThan(PLATFORM_JUMP_PEAK);
      expect(head - step.top, `seed ${seed}: step`).toBeGreaterThan(PLATFORM_JUMP_PEAK);
      expect(head - ledge.top, `seed ${seed}: ledge`).toBeLessThan(PLATFORM_JUMP_PEAK);
      // Boss stojí v jámě a římsu nepřečnívá: z římsy se na něj skáče, ne vchází.
      const world = worldOf(spec, seed);
      const run = runBot(world, undefined, { profile: 'intermediate' });
      let lowest = Number.POSITIVE_INFINITY;
      let highest = Number.NEGATIVE_INFINITY;
      const refs = refsOf(world);
      play(world, run.inputs, (state) => {
        for (const body of behaviourBodies(state, state[HEADER.player] as number, refs)) {
          const base = bodyBase(body);
          if ((state[base + BODY.y] as number) !== pit.top) continue;
          lowest = Math.min(lowest, (state[base + BODY.z] as number) - boss.d / 2);
          highest = Math.max(highest, (state[base + BODY.z] as number) + boss.d / 2);
        }
      });
      expect(lowest, `seed ${seed}: boss stays off the ledge`).toBeGreaterThan(ledge.far);
      expect(highest, `seed ${seed}: boss leaves the goal free`).toBeLessThan(goal.z);
    }
  });

  it.each(PACED.map((cell) => cell.id))('keeps %s lossless with the boss: playable, idle never wins, replay exact, novice 0.3–0.7, intermediate ≥ 0.8, every win beats the boss on its head before the finish; dead time ≤ 4 s, warnings ≥ TELEGRAPH_MIN', (id) => {
    const spec = specOfCell(id);
    const wins = { bot: 0, novice: 0, intermediate: 0 };
    const gaps: number[] = [];
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
      const boss = bossRun(world, run.inputs);
      // Zásah jen doskokem na hlavu; každý náběh až po celém varování.
      expect(boss.offHead, `${id}/${seed}: hits off the head`).toBe(0);
      for (const warned of boss.warnings) expect(warned, `${id}/${seed}: warning`).toBeGreaterThanOrEqual(TELEGRAPH_MIN);
      if (run.outcome !== 'won') continue;
      wins.intermediate += 1;
      // Finále: boss se 3 zásahy, který do cíle zmizí (měřidlo P45A), a výhru přinesl až cíl.
      expect(boss.hits, `${id}/${seed}: boss hits`).toBe(BRUTE.hp);
      // Padne právě třetím zásahem, ne dřív ani o doskok později.
      expect(boss.gone, `${id}/${seed}: boss gone with the last hit`).toBe(boss.lastHit);
      // Na hlavu se skáče z římsy nad jámou (R5), odrazy z hlavy se nepočítají.
      expect(boss.takeoffs, `${id}/${seed}: takeoffs`).toEqual(Array(BRUTE.hp).fill(PLATFORM_SEGMENTS.pit));
      expect(boss.gone, `${id}/${seed}: boss falls before the finish`).toBeLessThan(boss.end);
      expect(metrics.finale.why).toBe('boss');
      expect(run.tick).toBeGreaterThan(boss.gone);
    }
    expect(wins.bot, `${id}: playable`).toBe(1);
    expect(wins.intermediate / SEEDS.length, `${id}: intermediate`).toBeGreaterThanOrEqual(0.8);
    expect(wins.novice / SEEDS.length, `${id}: novice`).toBeGreaterThanOrEqual(0.3);
    expect(wins.novice / SEEDS.length, `${id}: novice`).toBeLessThanOrEqual(0.7);
    const sorted = [...gaps].sort((a, b) => a - b);
    expect((sorted[3]! + sorted[4]!) / 2, `${id}: dead time median ${sorted.join(',')}`).toBeLessThanOrEqual(4);
  }, 600_000);
});
