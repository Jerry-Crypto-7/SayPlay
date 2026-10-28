/**
 * Finále sběru a útěku s věcmi (P47A T3, jen `genre.v4`).
 *
 * Overlay šablona P45B (`treasure_rush`) pod průběhem přinese věci navíc a robot dosáhl cíle `grow_to` bez věcí
 * bosse (boss padl v 7/8 semínek, hra se čtyřmi vlnami ve 3/8). Ve v4 výhra počká na pád bosse (`grow_to.boss`,
 * vzor `fight_end.boss`) a robot od dosaženého skóre jde jen na bosse (`pacing_bot.points`); poslední vlna bez
 * věcí dá bosse se skóre (`boss_beat.score`) místo věcí. Rozpočet pravidel bosse nevyhodí ani u největší overlay
 * šablony. Přežití dostane v posledních 10 s déšť mincí (`FIELD.shower`): posledních 10 s vyhraného běhu je
 * ≥ 1,5× hustších než běh a telemetrie uzná finále `climax`.
 *
 * Uložené `genre.v3` hry staví týž svět (hashe v `pacing-template.test.ts`, replay brána).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, type ArcadeEffect, type ArcadeWorld, BODY, BODY_STRIDE, COUNTER, FLAG, HEADER, type PieceRef, ROLE, bodyBase, underlyingRule } from '../contract';
import { instantiate } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import type { ArcadeParts } from '../addons';
import { growTo } from '../pieces/arena';
import { type BehaviourRef, behaviourBodies } from '../pieces/behaviours';
import { play } from '../pieces/behaviours/__tests__/harness';
import { FIELD, FINALE_GENRE_VERSION, genreAtLeast, pacingParts } from '../pieces/pacing-parts';
import type { WaveParams } from '../pieces/waves';
import { loadRapier } from '../physics/world';
import { RULE_TEMPLATES, templateParts } from '../rules/templates';
import { CLIMAX_FACTOR, CLIMAX_TICKS, funMetrics, traceRun } from '../telemetry';
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
  // P61 T5: „three treasure chests“ s počtem má od T5-R1 vlny i bosse s poslední truhlou, ale výhru dává počet (`catch_goal`,
  // `goal-count.test.ts`), ne `grow_to` s bránou bosse – tu měří táž věta bez počtu.
  ['c08 castle', () => draft('Explore an old castle to find treasure chests')],
  ['e01 mushrooms', () => draft('Pick up glowing mushrooms in a dark forest and avoid the wolves')],
  // P63 T4: „Collect three keys in a pyramid while mummies chase you“ s počtem je útěk se sběrem počtu (`p63-count.test.ts`)
  // – výhru dává počet, ne `grow_to` s bránou bosse. Bez počtu by ji slova dala běžci, proto útěk s klíči bez počtu jinými slovy.
  ['e02 pyramid', () => draft('Pick up keys in a pyramid and avoid the mummies')],
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
      expect(genreAtLeast(spec, FINALE_GENRE_VERSION), id).toBe(true);
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
    // P61 T5: s počtem („five glowing mushrooms“) hraje věta právě pět hub bez šablony a bez brány skóre – výhru dává počet
    // (`goal-count.test.ts`); brána skóre se měří bez počtu.
    const spec = draft('Collect glowing mushrooms in a moonlit forest');
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

/** Přežití: buňka s jedním životem bez šablony a věty dev sady P47A se šablonou (tři životy). */
const SURVIVAL_GAMES: readonly [string, () => GameSpecV1][] = [
  ['cell arena.escape', () => cellSpec('arena.escape')],
  ['e03 graveyard', () => draft('Survive a horde of skeletons in a graveyard until sunrise')],
  ['e04 factory', () => draft('Survive the robot uprising in a factory for one minute')],
];

/** Kroky rozvrhu pravidla `pacing`, jejichž předloha je věc (mince deště), ne chování. */
function showerOf(world: ArcadeWorld): { atPermille: number; template: number; count: number }[] {
  const schedule = (ruleOf(world, 'pacing')!.params as { schedule: { atPermille: number; template: number; count: number }[] }).schedule;
  return schedule.filter((step) => world.initial[bodyBase(step.template) + BODY.role] === ROLE.collectible);
}

/** Herní události posledních `CLIMAX_TICKS` a celého běhu, jak je počítá telemetrie (bez konce běhu a skóre v tiku jiné události). */
function densityOf(world: ArcadeWorld, inputs: Parameters<typeof traceRun>[1]): { late: number; all: number; ticks: number } {
  const trace = traceRun(world, inputs);
  const busy = new Set(trace.events.filter((e) => e.kind !== 'score' && e.kind !== 'win' && e.kind !== 'lose').map((e) => e.tick));
  const ticks = trace.events.filter((e) => e.kind !== 'win' && e.kind !== 'lose' && !(e.kind === 'score' && busy.has(e.tick))).map((e) => e.tick);
  return { late: ticks.filter((tick) => tick >= trace.ticks - CLIMAX_TICKS).length, all: ticks.length, ticks: trace.ticks };
}

describe('survival: the last wave ends with a coin shower the telemetry sees (genre.v4)', () => {
  it('a v4 survival game gets the shower in its last 10 s, after the last wave starts; the same game stored as v3 does not', () => {
    for (const [id, make] of SURVIVAL_GAMES) {
      const spec = make();
      expect(genreAtLeast(spec, FINALE_GENRE_VERSION), id).toBe(true);
      for (const seed of SEEDS.slice(0, 3)) {
        const world = worldOf(spec, seed);
        expect((ruleOf(world, 'pacing')!.params as { finale: string }).finale, id).toBe('wave');
        const ticks = (ruleOf(world, 'survive_time')!.params as { seconds: number }).seconds * ARCADE_HZ;
        const count = (ruleOf(world, 'arena_waves')!.params as WaveParams).waves.length + 1;
        const shower = showerOf(world);
        expect(shower.length, `${id} seed ${seed}`).toBe(1);
        const [step] = shower as [(typeof shower)[number]];
        expect(step.count, id).toBe(FIELD.shower.count);
        expect(step.atPermille, id).toBeGreaterThanOrEqual(Math.floor(((count - 1) * 1000) / count));
        // Postup podle času: krok přijde v tiku, kdy podíl uběhlého času dojde na `atPermille` – v okně finále telemetrie.
        const arrives = Math.ceil((step.atPermille * ticks) / 1000);
        expect(arrives, id).toBeGreaterThanOrEqual(ticks - CLIMAX_TICKS);
        expect(arrives, id).toBeLessThanOrEqual(ticks - FIELD.shower.lead + Math.ceil(ticks / 1000));
        // Mince nikoho nezraní: věc, ne hrozba, a `arena_eat` ji hráči dá za skóre.
        expect(world.initial[bodyBase(step.template) + BODY.role], id).toBe(ROLE.collectible);
      }
      // Uložená v3: buňka má průběh bez deště, věty se šablonou průběh nemají vůbec (T2).
      const stored = worldOf(withVersion(spec, 'genre.v3'));
      if (ruleOf(stored, 'pacing') !== undefined) expect(showerOf(stored), `${id} v3`).toEqual([]);
      else expect(id.startsWith('cell'), `${id} v3`).toBe(false);
    }
  });

  it('every intermediate win has a last 10 s at least 1.5x denser than the run (climax); the bands hold', () => {
    for (const [id, make] of SURVIVAL_GAMES) {
      const spec = make();
      let wins = 0;
      let novice = 0;
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
        if (runBot(world, ARCADE_LIBRARY, { profile: 'novice' }).outcome === 'won') novice += 1;
        if (bot.outcome !== 'won') continue;
        wins += 1;
        const { late, all, ticks } = densityOf(world, bot.inputs);
        expect(late * ticks, `${id} seed ${seed}: ${late} of ${all} events in the last 10 s of ${ticks} ticks`).toBeGreaterThanOrEqual(CLIMAX_FACTOR * all * CLIMAX_TICKS);
        expect(funMetrics(traceRun(world, bot.inputs)).finale.why, `${id} seed ${seed}`).toBe('climax');
      }
      expect(wins, `${id}: intermediate wins`).toBeGreaterThanOrEqual(7);
      // Pásmo začátečníka v živé buňce (semínka 1–8: 5/8 jako bez deště); věty dev sady přežití jsou nad 0,7 už bez něj.
      if (id.startsWith('cell')) {
        expect(novice, `${id}: novice wins`).toBeGreaterThanOrEqual(3);
        expect(novice, `${id}: novice wins`).toBeLessThanOrEqual(6);
      }
    }
  }, 600_000);
});
