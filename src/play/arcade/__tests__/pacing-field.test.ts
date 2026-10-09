/**
 * Průběh otevřeného pole (P45C T12, část A): aréna – přežití, sběr, útěk
 * s věcmi – a souboj. Dnešní vlny zůstávají, křivka jim dává rychlost, od
 * druhé vlny přijdou nejvýš dvě nová chování losovaná ze streamu `pacing` a
 * hra má finále: sběr a útěk s věcmi bosse, který nese poslední vlnu věcí,
 * přežití poslední vlnu ve vrcholu křivky, souboj bosse jako poslední vlnu.
 * Každá živá buňka (8 semínek): stoupá, ≥ 2 chování, finále, robot
 * intermediate ≥ 7/8, nečinný hráč nikdy, 30–90 s, přehrání = hash.
 * Odchylky (změřené robotem bez profilu, brána publikace): v přežití a souboji
 * chování odejdou se začátkem poslední vlny, přežití drží rychlost vln
 * (`steady`), uhnutí, které hráče zažene k pronásledovateli, neplatí, a hry
 * s pravidly, věcmi či díly specu průběh nedostanou.
 */

import { describe, expect, it } from 'vitest';

import { behavioursOf, finaleOf, pressureRun, risingOf } from '../../../../evals/play/p45c/pacing';
import { arcadeWorldOf, generatorOf, preloadPhysics } from '../compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, FLAG, HEADER, type PieceRef, ROLE, UNIT, bodyBase, underlyingRule } from '../contract';
import { instantiate } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { arenaAxis } from '../pieces/arena';
import { type BehaviourRef, CHASER_CHECK, behaviourBodies, chaserClearance } from '../pieces/behaviours';
import { play } from '../pieces/behaviours/__tests__/harness';
import { PACING, type PacingRuleParams, intensityAt, pacingRule, TENSION_CURVE } from '../pieces/pacing';
import { FIELD, GENRE_PACING, pacingProbeBodies } from '../pieces/pacing-parts';
import type { WaveParams } from '../pieces/waves';
import { loadRapier } from '../physics/world';
import { runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { GenreSpec } from '@/play/genre/contract';
import { compileGenre, readGenreSpec } from '@/play/genre';
import type { GameSpecV1 } from '@/play/spec';

const FIELD_GENERATORS = ['arena_collect', 'arena_escape', 'fight'];
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const CELLS = liveCells().filter((cell) => {
  const spec = compileRecipe(assemblyOfCell(cell));
  return spec.genre !== undefined && FIELD_GENERATORS.includes(generatorOf(spec));
});
const cellSpec = (id: string): GameSpecV1 => compileRecipe(assemblyOfCell(CELLS.find((cell) => cell.id === id)!));

const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
/** Tatáž hra uložená před průběhem (`genre.v1`). */
const storedOf = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v1' } });

const chain = (ref: PieceRef): PieceRef[] => {
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? [ref] : [ref, ...chain(base)];
};
const ruleOf = (world: ArcadeWorld, id: string): PieceRef | undefined => world.rules.map(underlyingRule).find((rule) => rule.id === id);
const pacedRefs = (world: ArcadeWorld): readonly BehaviourRef[] => (chain(world.control).find((ref) => ref.id === 'pacing_control')?.params.behaviours ?? []) as BehaviourRef[];
const bossRef = (world: ArcadeWorld): BehaviourRef | undefined => pacedRefs(world).find((ref) => ref.id === 'boss');
const wavesOf = (world: ArcadeWorld): WaveParams => ruleOf(world, 'arena_waves')!.params as WaveParams;
const scheduleOf = (world: ArcadeWorld): { atPermille: number; template: number }[] => (ruleOf(world, 'pacing')!.params as { schedule: { atPermille: number; template: number }[] }).schedule;

/** Tik, kdy se boss poprvé objevil a kdy zmizel (−1 = nikdy), a tik konce běhu. */
function bossTrace(world: ArcadeWorld, inputs: Parameters<typeof play>[1]): { seen: number; fell: number; end: number } {
  const ref = bossRef(world)!;
  let seen = -1;
  let fell = -1;
  const state = play(world, inputs, (now, tick) => {
    const alive = behaviourBodies(now, now[HEADER.player] as number, [ref]).length > 0;
    if (alive && seen < 0) seen = tick;
    if (!alive && seen >= 0 && fell < 0) fell = tick;
  });
  return { seen, fell, end: state[HEADER.tick] as number };
}

describe('open-field genres are paced (arena and fight)', () => {
  it('covers every live arena cell with a genre', () => {
    expect(CELLS.map((cell) => cell.id).sort()).toEqual(['arena.collect', 'arena.escape', 'arena.escape+collect', 'arena.fight']);
  });

  for (const cell of CELLS) {
    it(`${cell.id}: rising, two or more behaviours, a finale, bot wins 7/8 in 30–90 s, idle loses, replay equal`, async () => {
      const spec = compileRecipe(assemblyOfCell(cell));
      await preloadPhysics(spec, loadRapier);
      let wins = 0;
      for (const seed of SEEDS) {
        const made = arcadeWorldOf(spec, seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        const { world } = made;
        expect(chain(world.control).map((ref) => ref.id)).toContain('pacing_control');
        expect(finaleOf(world), `${cell.id} seed ${seed}: finale`).toBe(true);
        expect(behavioursOf(world).length, `${cell.id} seed ${seed}: ${behavioursOf(world).join('+')}`).toBeGreaterThanOrEqual(2);
        const verdict = verifyArcade(world, ARCADE_LIBRARY, made.roleBindings);
        expect(verdict.idle.outcome, `${cell.id} seed ${seed}: idle`).not.toBe('won');
        expect(verdict.replayEqual).toBe(true);
        const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
        const run = pressureRun(world, bot.inputs);
        expect(run.hash).toBe(bot.hash);
        expect(risingOf(run.threatsPerThird), `${cell.id} seed ${seed}: pressure by thirds ${run.threatsPerThird.join(' / ')}`).toBe(true);
        if (bot.outcome === 'won') {
          wins += 1;
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeGreaterThanOrEqual(30);
          expect(bot.tick / ARCADE_HZ, `${cell.id} seed ${seed}: length`).toBeLessThanOrEqual(90);
        }
      }
      expect(wins, `${cell.id}: intermediate wins`).toBeGreaterThanOrEqual(7);
    }, 600_000);
  }

  it('brings at most two new behaviours per game, drawn per seed, none before the second wave', () => {
    for (const cell of CELLS) {
      const spec = cellSpec(cell.id);
      const draws = new Set<string>();
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const foes = pacingProbeBodies(world).filter((probe) => probe.behaviour !== 'boss');
        expect(foes.length, cell.id).toBeGreaterThanOrEqual(1);
        expect(foes.length, cell.id).toBeLessThanOrEqual(2);
        const second = Math.floor(1000 / (wavesOf(world).waves.length + 1));
        const spawns = scheduleOf(world).filter((step) => step.template !== bossRef(world)?.template);
        expect(spawns.length, cell.id).toBeGreaterThan(0);
        for (const entry of spawns) expect(entry.atPermille, `${cell.id} seed ${seed}`).toBeGreaterThanOrEqual(second);
        draws.add(spawns.map((step) => foes.find((foe) => foe.body === step.template)!.behaviour).join('+'));
      }
      // Los ze streamu `pacing`: které chování hra dostane a které přinese každý spawn – osm semínek nedá všem totéž.
      expect(draws.size, cell.id).toBeGreaterThan(1);
    }
  });

  it('collect and escape with items: the boss arrives with the last wave and carries its items, the wave does not bring them', () => {
    for (const id of ['arena.collect', 'arena.escape+collect']) {
      const spec = cellSpec(id);
      const paced = worldOf(spec), stored = worldOf(storedOf(spec));
      const own = wavesOf(paced), before = wavesOf(stored);
      const lastBefore = before.waves.at(-1)!.items ?? [];
      const carried = Math.min(FIELD.carry, lastBefore.length / 2);
      const beat = ruleOf(paced, 'boss_beat')!.params as { boss: number; drop: { template: number; count: number } };
      expect(beat.boss).toBe(bossRef(paced)!.template);
      expect(beat.drop).toEqual({ template: before.item, count: carried });
      expect((own.waves.at(-1)!.items ?? []).length).toBe(lastBefore.length - 2 * carried);
      // Vlny a jejich čítače zůstávají: stejné vstupy, pravidlo, počet vln a věci dřívějších vln.
      expect(own.waves.slice(0, -1)).toEqual(before.waves.slice(0, -1));
      expect({ ...own, waves: [] }).toEqual({ ...before, waves: [] });
      // Boss přijde se začátkem poslední vlny; pronásledovatelé s ním odejdou a poslední vlna žádné nepřivede.
      const count = before.waves.length + 1;
      const at = Math.floor(((count - 1) * 1000) / count);
      expect(scheduleOf(paced).find((step) => step.template === beat.boss)!.atPermille).toBe(at);
      const pacing = ruleOf(paced, 'pacing')!.params as { finale: string; clear: unknown };
      expect(pacing.finale).toBe('boss');
      expect(pacing.clear).toEqual([{ role: ROLE.chaser, at }]);
      expect(own.waves.at(-1)!.chasers).toBe(0);
      // Věcí k výhře je pořád přesně tolik, kolik chce `grow_to`: první vlna na zemi, další vlny, zbytek nese boss.
      const points = (ruleOf(paced, 'grow_to')!.params as { points: number }).points;
      const perWave = before.waves[0]!.items!.length / 2;
      expect(perWave * count).toBe(points);
      expect(own.waves.reduce((sum, wave) => sum + (wave.items ?? []).length / 2, perWave) + carried).toBe(points);
    }
  });

  it('a boss carrying the last items falls to the bot before the collect clock runs out (pin)', () => {
    const spec = cellSpec('arena.collect');
    let beaten = 0;
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      const clock = (ruleOf(world, 'time_limit')!.params as { seconds: number }).seconds * ARCADE_HZ;
      expect(clock).toBeLessThanOrEqual(88 * ARCADE_HZ);
      const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      const trace = bossTrace(world, bot.inputs);
      // Výhra potřebuje věci, které nese boss: bez jeho pádu nejde.
      if (bot.outcome === 'won') expect(trace.fell, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      if (trace.fell >= 0 && trace.fell < clock && bot.outcome === 'won') beaten += 1;
    }
    expect(beaten).toBeGreaterThanOrEqual(7);
  });

  it('fight: the last wave is the boss – it comes with the last wave and the win waits for its fall', () => {
    const spec = cellSpec('arena.fight');
    const stored = worldOf(storedOf(spec));
    let fallen = 0;
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      const boss = bossRef(world)!.template;
      expect((ruleOf(world, 'fight_end')!.params as { boss?: number }).boss).toBe(boss);
      const own = wavesOf(world), before = wavesOf(stored);
      const count = before.waves.length + 1;
      expect(scheduleOf(world).find((step) => step.template === boss)!.atPermille).toBe(Math.floor(((count - 1) * 1000) / count));
      expect(own.waves.slice(0, -1)).toEqual(wavesOf(worldOf(storedOf(spec), seed)).waves.slice(0, -1));
      expect(own.waves.at(-1)).toEqual({ ...before.waves.at(-1), enemies: 0, hp: Math.min(FIELD.lastHp, before.waves.at(-1)!.hp!) });
      const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      const trace = bossTrace(world, bot.inputs);
      if (bot.outcome === 'won') {
        expect(trace.fell, `seed ${seed}: the win came before the boss fell`).toBeGreaterThanOrEqual(0);
        fallen += 1;
      }
    }
    expect(fallen).toBeGreaterThanOrEqual(7);
  });

  it('survival: the last wave runs at the peak of the curve, without a boss', () => {
    const world = worldOf(cellSpec('arena.escape'));
    const waves = wavesOf(world);
    expect((ruleOf(world, 'pacing')!.params as { finale: string }).finale).toBe('wave');
    expect(ruleOf(world, 'boss_beat')).toBeUndefined();
    expect(intensityAt(Math.floor((waves.waves.length * 1000) / (waves.waves.length + 1)), TENSION_CURVE)).toBeGreaterThanOrEqual(PACING.intensity.peak);
    expect(wavesOf(world)).toEqual(wavesOf(worldOf(storedOf(cellSpec('arena.escape')))));
    // Rychlost pronásledovatelů dál dávají vlny (`steady`): pomalejší úvod křivky dal buňce s jedním životem začátečníka 0,9.
    expect(chain(world.control).find((ref) => ref.id === 'pacing_control')!.params.steady).toBe(true);
    expect(chain(world.bot).find((ref) => ref.id === 'pacing_bot')!.params.steady).toBe(true);
  });

  it('survival and fight: the new behaviours come only before the last wave and leave when it starts', () => {
    for (const id of ['arena.escape', 'arena.fight']) {
      for (const seed of SEEDS) {
        const world = worldOf(cellSpec(id), seed);
        const count = wavesOf(world).waves.length + 1;
        const last = Math.floor(((count - 1) * 1000) / count);
        const pacing = ruleOf(world, 'pacing')!.params as { clear: unknown };
        // Těla chování a jejich výstřely jsou `hazard`; boss souboje přijde v témže tiku až po úklidu.
        expect(pacing.clear, `${id} seed ${seed}`).toEqual([{ role: ROLE.hazard, at: last }]);
        const foes = scheduleOf(world).filter((step) => step.template !== bossRef(world)?.template);
        expect(foes.length, `${id} seed ${seed}`).toBeGreaterThan(0);
        // Souboj postupuje po vlnách skokem: spawn musí přijít nejpozději se začátkem předposlední vlny.
        const until = id === 'arena.fight' ? Math.floor(((count - 2) * 1000) / count) : last - 1;
        for (const step of foes) expect(step.atPermille, `${id} seed ${seed}`).toBeLessThanOrEqual(until);
      }
    }
  });

  it('a spawn step of a wave that a clear already ended does not come (a wave goal jumps over both)', () => {
    const world = worldOf(cellSpec('arena.fight'));
    const params = ruleOf(world, 'pacing')!.params as PacingRuleParams;
    const keeper = params.keeper;
    const state = instantiate(world);
    const foe = scheduleOf(world).find((step) => step.template !== bossRef(world)?.template)!;
    const at = params.clear![0]!.at;
    // Postup skočí přes krok rozvrhu i přes úklid v jednom tiku: přijde jen boss, chování ne.
    state[bodyBase(keeper) + BODY.aux1] = foe.atPermille - 1;
    state[bodyBase(keeper) + BODY.aux0] = at;
    const effects = pacingRule.fire({ state, player: state[HEADER.player] as number, other: -1, source: -1 } as never, { ...params, schedule: [{ ...params.schedule.find((step) => step.template === foe.template)!, atPermille: foe.atPermille }, ...params.schedule.filter((step) => step.template === bossRef(world)!.template)] });
    const spawned = effects.flatMap((effect) => (effect.kind === 'spawn' ? [effect.template] : []));
    expect(spawned).toEqual([bossRef(world)!.template]);
  });

  it('a dodge that would stop the bot in front of a pursuer does not count (chaser check)', () => {
    const world = worldOf(cellSpec('arena.escape'));
    const state = instantiate(world);
    const player = state[HEADER.player] as number;
    const chasers = Array.from({ length: state[HEADER.bodyCount] as number }, (_, body) => body).filter((body) => state[bodyBase(body) + BODY.role] === ROLE.chaser && (state[bodyBase(body) + BODY.flags]! & FLAG.alive) !== 0);
    expect(chasers.length).toBeGreaterThan(0);
    for (const body of chasers.slice(1)) state[bodyBase(body) + BODY.flags] = state[bodyBase(body) + BODY.flags]! & ~FLAG.alive;
    const p = bodyBase(player);
    const c = bodyBase(chasers[0]!);
    for (const slot of ['x', 'z', 'vx', 'vz'] as const) state[p + BODY[slot]] = 0;
    state[c + BODY.x] = 0;
    state[c + BODY.z] = -5 * UNIT / 2;
    const observation = { state, player, tick: 0, recent: [] };
    expect(chaserClearance(observation, { buttons: 0, axis: 0 })).toBeLessThan(CHASER_CHECK.gap);
    expect(chaserClearance(observation, { buttons: 0, axis: arenaAxis(0, 1000) })).toBeGreaterThanOrEqual(CHASER_CHECK.gap);
    // Bez pronásledovatele uhnutí platí vždy.
    state[c + BODY.flags] = state[c + BODY.flags]! & ~FLAG.alive;
    expect(chaserClearance(observation, { buttons: 0, axis: 0 })).toBe(Number.POSITIVE_INFINITY);
  });

  it('a game with spec rules, things or assembly parts keeps its unpaced world', () => {
    const read = readGenreSpec({ genre: 'arena', mode: 'collect', hero: 'explorer', collectible: 'gem', setting: 'volcano cave', ruleRoles: [{ id: 'lava', kind: 'hazard', label: 'lava pool' }], rules: [{ id: 'burn', verb: 'touch', when: { contact: ['player', 'lava'] }, do: [{ lose: true }] }] });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const lava = compileGenre(read.value as GenreSpec);
    expect(lava.rules?.length).toBe(1);
    const assembled = compileRecipe({ preset: 'assembled', move: 'roam', actions: [], objective: 'reach', threats: ['chaser'], content: { genre: 'arena', mode: 'collect', hero: 'robot', setting: 'forest' }, parts: [{ kind: 'chaser', role: 'part_0', label: 'bear', phase: 0, motion: 'fall' }] } as never);
    for (const spec of [lava, assembled]) {
      expect(spec.genre?.compilerVersion).not.toBe('genre.v1');
      expect(chain(worldOf(spec).control).map((ref) => ref.id)).not.toContain('pacing_control');
    }
  });

  it('a fight with at most two lives and a collect with one life keep their unpaced world; three lives get pacing', () => {
    const genre = (input: Record<string, unknown>): GameSpecV1 => {
      const read = readGenreSpec({ genre: 'arena', hero: 'knight', setting: 'castle', ...input });
      if (!read.ok) throw new Error(read.issues.join('; '));
      return compileGenre(read.value as GenreSpec);
    };
    const paced = (spec: GameSpecV1): boolean => chain(worldOf(spec).control).some((ref) => ref.id === 'pacing_control');
    expect(paced(genre({ mode: 'fight', params: { lives: 1 } }))).toBe(false);
    expect(paced(genre({ mode: 'fight', params: { lives: 2 } }))).toBe(false);
    expect(paced(genre({ mode: 'fight', params: { lives: 3 } }))).toBe(true);
    expect(paced(genre({ mode: 'collect', cast: [{ label: 'coin', does: 'collect' }], params: { lives: 1 } }))).toBe(false);
    expect(paced(genre({ mode: 'collect', cast: [{ label: 'coin', does: 'collect' }], params: { lives: 2 } }))).toBe(true);
  });

  it('a game stored before pacing (genre.v1) builds exactly as without the records', () => {
    for (const cell of CELLS) {
      const spec = storedOf(cellSpec(cell.id));
      const generator = generatorOf(spec);
      const record = GENRE_PACING[generator];
      const before = worldOf(spec);
      try {
        delete GENRE_PACING[generator];
        expect(worldOf(spec), cell.id).toEqual(before);
      } finally {
        GENRE_PACING[generator] = record;
      }
      expect(chain(before.control).map((ref) => ref.id)).not.toContain('pacing_control');
    }
  });
});
