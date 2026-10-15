/**
 * Finále sběru a útěku s věcmi (P47A T3, jen `genre.v4`).
 *
 * Overlay šablona P45B (`treasure_rush`) pod průběhem přinese věci navíc a robot dosáhl cíle `grow_to` bez věcí
 * bosse (boss padl v 7/8 semínek, hra se čtyřmi vlnami ve 3/8). Ve v4 výhra počká na pád bosse (`grow_to.boss`,
 * vzor `fight_end.boss`) a robot od dosaženého skóre jde jen na bosse (`pacing_bot.points`); poslední vlna bez
 * věcí dá bosse se skóre (`boss_beat.score`) místo věcí. Rozpočet pravidel bosse nevyhodí ani u největší overlay
 * šablony. Finále přežití T3 nedodala (`evals/play/p47a/README.md`, Rozhodnutí).
 *
 * Uložené `genre.v3` hry staví týž svět (hashe v `pacing-template.test.ts`, replay brána).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../compile';
import { type ArcadeEffect, type ArcadeWorld, BODY, BODY_STRIDE, COUNTER, FLAG, HEADER, type PieceRef, bodyBase, underlyingRule } from '../contract';
import { instantiate } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import type { ArcadeParts } from '../addons';
import { growTo } from '../pieces/arena';
import { type BehaviourRef, behaviourBodies } from '../pieces/behaviours';
import { play } from '../pieces/behaviours/__tests__/harness';
import { FIELD, FINALE_GENRE_VERSION, pacingParts } from '../pieces/pacing-parts';
import type { WaveParams } from '../pieces/waves';
import { loadRapier } from '../physics/world';
import { RULE_TEMPLATES, templateParts } from '../rules/templates';
import { funMetrics, traceRun } from '../telemetry';
import { runBot } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const cellSpec = (id: string): GameSpecV1 => compileRecipe(assemblyOfCell(liveCells().find((cell) => cell.id === id)!));
const draft = (text: string): GameSpecV1 => draftGameSpecWithMeta(text, 1).spec;
const withVersion = (spec: GameSpecV1, version: string): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: version } });
const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
const chain = (ref: PieceRef): PieceRef[] => {
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? [ref] : [ref, ...chain(base)];
};
const ruleOf = (world: Pick<ArcadeWorld, 'rules'>, id: string): PieceRef | undefined => world.rules.map(underlyingRule).find((rule) => rule.id === id);
const pacedRefs = (world: ArcadeWorld): readonly BehaviourRef[] => (chain(world.control).find((ref) => ref.id === 'pacing_control')?.params.behaviours ?? []) as BehaviourRef[];
const bossRef = (world: ArcadeWorld): BehaviourRef | undefined => pacedRefs(world).find((ref) => ref.id === 'boss');
const won = (effects: readonly ArcadeEffect[]): boolean => effects.some((effect) => effect.kind === 'win');

/** Sběr a útěk s věcmi: buňky bez šablony a věty dev sady P47A se šablonou `treasure_rush` / `waves_survive`. */
const ITEM_GAMES: readonly [string, () => GameSpecV1][] = [
  ['cell arena.collect', () => cellSpec('arena.collect')],
  ['cell arena.escape+collect', () => cellSpec('arena.escape+collect')],
  ['c02 bee', () => draft('A bee collects pollen in a meadow full of hungry frogs')],
  ['c08 castle', () => draft('Explore an old castle to find three treasure chests')],
  ['e01 mushrooms', () => draft('Pick up glowing mushrooms in a dark forest and avoid the wolves')],
  ['e02 pyramid', () => draft('Collect three keys in a pyramid while mummies chase you')],
];

/** Tik, kdy se boss poprvé objevil a kdy zmizel (−1 = nikdy). */
function bossTrace(world: ArcadeWorld, inputs: Parameters<typeof play>[1]): { seen: number; fell: number } {
  const ref = bossRef(world)!;
  let seen = -1;
  let fell = -1;
  play(world, inputs, (now, tick) => {
    const alive = behaviourBodies(now, now[HEADER.player] as number, [ref]).length > 0;
    if (alive && seen < 0) seen = tick;
    if (!alive && seen >= 0 && fell < 0) fell = tick;
  });
  return { seen, fell };
}

beforeAll(async () => {
  await loadRapier();
});

describe('collect and item escape: the boss is the last step to the win (genre.v4)', () => {
  it('grow_to with a boss waits while a copy of the boss stands; without the parameter it wins as before', () => {
    const world = worldOf(cellSpec('arena.collect'));
    const grow = ruleOf(world, 'grow_to')!.params as { points: number; boss?: number };
    const boss = bossRef(world)!.template;
    expect(grow.boss).toBe(boss);
    const state = instantiate(world);
    const context = { state, player: state[HEADER.player] as number, other: -1, source: -1 } as never;
    state[HEADER.counters + COUNTER.score] = grow.points - 1;
    expect(won(growTo.fire(context, grow))).toBe(false);
    state[HEADER.counters + COUNTER.score] = grow.points;
    expect(won(growTo.fire(context, grow))).toBe(true);
    // Živá kopie předlohy bosse v prvním slotu spawnu: výhra počká, bez parametru ne.
    const slot = state[HEADER.spawnBase] as number;
    state.copyWithin(bodyBase(slot), bodyBase(boss), bodyBase(boss) + BODY_STRIDE);
    state[HEADER.bodyCount] = Math.max(state[HEADER.bodyCount] as number, slot + 1);
    state[bodyBase(slot) + BODY.flags] = (state[bodyBase(slot) + BODY.flags] as number) | FLAG.alive;
    expect(won(growTo.fire(context, grow))).toBe(false);
    expect(won(growTo.fire(context, { points: grow.points }))).toBe(true);
    // Padlý boss: výhra.
    state[bodyBase(slot) + BODY.flags] = (state[bodyBase(slot) + BODY.flags] as number) & ~FLAG.alive;
    expect(won(growTo.fire(context, grow))).toBe(true);
  });

  it('every v4 collect and item-escape game gates the win on its boss; the same game stored as v3 does not', () => {
    for (const [id, make] of ITEM_GAMES) {
      const spec = make();
      expect(spec.genre?.compilerVersion, id).toBe(FINALE_GENRE_VERSION);
      for (const seed of SEEDS.slice(0, 3)) {
        const world = worldOf(spec, seed);
        expect((ruleOf(world, 'pacing')!.params as { finale: string }).finale, id).toBe('boss');
        const beat = ruleOf(world, 'boss_beat')!.params as { boss: number; drop?: unknown };
        expect(beat.boss, id).toBe(bossRef(world)!.template);
        expect(beat.drop, id).toBeDefined();
        expect((ruleOf(world, 'grow_to')!.params as { boss?: number }).boss, `${id} seed ${seed}`).toBe(beat.boss);
        expect((ruleOf(worldOf(withVersion(spec, 'genre.v3'), seed), 'grow_to')!.params as { boss?: number }).boss, `${id} v3`).toBeUndefined();
      }
    }
  });

  it('the boss falls before the win in every intermediate win and the telemetry sees it; the bands hold', () => {
    for (const [id, make] of ITEM_GAMES) {
      const spec = make();
      let wins = 0;
      let novice = 0;
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
        if (runBot(world, ARCADE_LIBRARY, { profile: 'novice' }).outcome === 'won') novice += 1;
        if (bot.outcome !== 'won') continue;
        wins += 1;
        const { seen, fell } = bossTrace(world, bot.inputs);
        expect(seen, `${id} seed ${seed}: the boss never came`).toBeGreaterThanOrEqual(0);
        expect(fell, `${id} seed ${seed}: the win came before the boss fell`).toBeGreaterThanOrEqual(0);
        expect(funMetrics(traceRun(world, bot.inputs)).finale.why, `${id} seed ${seed}`).toBe('boss');
      }
      expect(wins, `${id}: intermediate wins`).toBeGreaterThanOrEqual(7);
      // Pásmo začátečníka v živých buňkách; věty dev sady sběru jsou nad 0,7 už bez P47A (README, T2).
      if (id.startsWith('cell')) {
        expect(novice, `${id}: novice wins`).toBeGreaterThanOrEqual(3);
        expect(novice, `${id}: novice wins`).toBeLessThanOrEqual(6);
      }
    }
  }, 600_000);

  it('once the score is reached the bot goes for the boss: the publication bot wins where it circled an item until the clock', () => {
    const spec = draft('Collect five glowing mushrooms in a moonlit forest');
    expect(spec.rules?.map((rule) => rule.id)).toEqual(['herald', 'shower', 'settle']);
    for (const seed of [4, 33]) {
      const world = worldOf(spec, seed * 7919);
      const points = (ruleOf(world, 'grow_to')!.params as { points: number }).points;
      expect(chain(world.bot).find((ref) => ref.id === 'pacing_bot')!.params.points).toBe(points);
      const bot = runBot(world, ARCADE_LIBRARY);
      expect(bot.outcome, `seed ${seed}`).toBe('won');
      expect(bossTrace(world, bot.inputs).fell, `seed ${seed}`).toBeGreaterThanOrEqual(0);
    }
    expect(chain(worldOf(withVersion(cellSpec('arena.collect'), 'genre.v3')).bot).find((ref) => ref.id === 'pacing_bot')!.params.points).toBeUndefined();
  });

  it('a last wave without items gets a boss that gives score instead (v4); v3 keeps the wave finale without a boss', () => {
    const spec = cellSpec('arena.collect');
    const { generator: _generator, tuning, ...params } = spec.controlParams as Record<string, unknown> & { tuning?: Record<string, unknown> };
    const piece = MODE_GENERATORS.arena_collect!;
    const own = piece.parts(1, piece.params.parse({ ...params, ...tuning }), 3) as ArcadeParts;
    const waves = ruleOf(own, 'arena_waves')!.params as WaveParams;
    const bare = (change: (params: WaveParams) => WaveParams): ArcadeParts => ({ ...own, rules: own.rules.map((rule) => (rule.id === 'arena_waves' ? { ...rule, params: change(rule.params as WaveParams) } : rule)) });
    const emptyLast = bare((p) => ({ ...p, waves: p.waves.map((wave, index) => (index < p.waves.length - 1 ? wave : (({ items: _items, ...rest }) => rest)(wave))) }));
    const noItem = bare(({ item: _item, ...rest }) => rest as WaveParams);
    expect(waves.waves.at(-1)!.items?.length).toBeGreaterThan(0);
    for (const parts of [emptyLast, noItem]) {
      const paced = pacingParts(parts, spec, 1, 'arena_collect');
      const beat = ruleOf(paced, 'boss_beat')!.params as { boss: number; drop?: unknown; score?: number };
      expect(beat.drop).toBeUndefined();
      expect(beat.score).toBe(FIELD.bossScore);
      expect((ruleOf(paced, 'pacing')!.params as { finale: string }).finale).toBe('boss');
      expect((ruleOf(paced, 'grow_to')!.params as { boss?: number }).boss).toBe(beat.boss);
      // Věci poslední vlny zůstanou, kde byly; noví pronásledovatelé s bossem nepřiběhnou.
      const last = (ruleOf(paced, 'arena_waves')!.params as WaveParams).waves.at(-1)!;
      expect(last.items).toEqual((ruleOf(parts, 'arena_waves')!.params as WaveParams).waves.at(-1)!.items);
      expect(last.chasers).toBe(0);
      const stored = pacingParts(parts, withVersion(spec, 'genre.v3'), 1, 'arena_collect');
      expect(ruleOf(stored, 'boss_beat')).toBeUndefined();
      expect((ruleOf(stored, 'pacing')!.params as { finale: string }).finale).toBe('wave');
      expect((ruleOf(stored, 'grow_to')!.params as { boss?: number }).boss).toBeUndefined();
    }
  });

  it('the rule budget keeps the boss under the largest overlay template (waves_survive, 4 rules)', () => {
    const largest = (['treasure_rush', 'waves_survive', 'reinforcements'] as const).reduce((best, name) => (RULE_TEMPLATES[name].budget > RULE_TEMPLATES[best].budget ? name : best));
    expect(largest).toBe('waves_survive');
    // Šablona potřebuje roli nepřítele: sběr dev sady ji nemá (dostane `treasure_rush`, 3 pravidla – test výše), útěk s věcmi ano.
    for (const [id, make] of ITEM_GAMES.filter(([name]) => name.startsWith('e0'))) {
      const base = make();
      const enemy = base.roles.find((role) => role.kind === 'chaser')!;
      const parts = templateParts(largest, { enemy: enemy.id })!;
      const spec: GameSpecV1 = { ...base, rules: parts.rules, ...(parts.logic === undefined ? {} : { logic: parts.logic }) };
      expect(spec.rules?.length, id).toBe(RULE_TEMPLATES[largest].budget);
      const world = worldOf(spec);
      expect(world.rules.length, id).toBeLessThanOrEqual(16);
      expect((ruleOf(world, 'pacing')!.params as { finale: string }).finale, id).toBe('boss');
      expect(ruleOf(world, 'boss_beat'), id).toBeDefined();
      expect((ruleOf(world, 'grow_to')!.params as { boss?: number }).boss, id).toBe(bossRef(world)!.template);
    }
  });
});
