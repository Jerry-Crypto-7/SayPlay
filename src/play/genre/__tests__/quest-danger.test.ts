/**
 * Nebezpečí úkolu (P36A T3): úkol prohrává i jinak než časem.
 *
 * Co by vypadalo dobře a bylo špatně: HUD ukáže tři srdce, ale nečinný hráč
 * o žádné nepřijde a prohraje až na hodinách – úkol v prostoru bez honičky ve
 * větě i úkol na místě dřív nic neohrožovalo. Proto se tu měří tik první
 * ztráty života nečinného hráče proti časovému limitu světa, a že robot, který
 * hraje bez otálení, dál vyhrává (na místě bez jediné ztráty).
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, BUTTON, COUNTER, HEADER, NO_INPUT, ROLE, RUN_STATE, START_LIVES, bodyBase } from '@/play/arcade/contract';
import { buildWorld, instantiate, loadProgram, replay, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { QUEST, boilTicks, questStation } from '@/play/arcade/pieces/quest';
import { runBot } from '@/play/arcade/verify';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import type { GenreSpecOf } from '../contract';
import { GENRE_MODULES, compileGenre, readGenreSpec } from '../index';
import { DEFAULT_CHASERS } from '../quest';

/** Věty bez honičky: hasič v prostoru (dřív bez pronásledovatele), kuchař na místě. */
const SENTENCES = {
  spatial: 'A firefighter puts out burning trees in a forest',
  station: 'A chef flips pancakes in a restaurant kitchen',
} as const;

function draft(sentence: string): GenreSpecOf<'quest'> {
  const read = readGenreSpec({ hero: 'hero', setting: 'somewhere', ...GENRE_MODULES.quest.draftFill(sentence, null) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value as GenreSpecOf<'quest'>;
}

function gameOf(spec: GenreSpecOf<'quest'>): GameSpecV1 {
  const read = readGameSpec(compileGenre(spec));
  if (!read.ok) throw new Error(`${read.reason}: ${read.issues.join('; ')}`);
  return read.value;
}

/** Jako dveře publikace: první z osmi semínek, na kterém robot vyhraje. */
function publishedWorld(game: GameSpecV1): { readonly world: ArcadeWorld; readonly bot: ReturnType<typeof runBot> } {
  for (let seed = 1; seed <= 8; seed += 1) {
    const made = arcadeWorldOf(game, seed);
    if (!made.ok) continue;
    const bot = runBot(made.world);
    if (bot.outcome === 'won') return { world: made.world, bot };
  }
  throw new Error(`the bot wins ${game.title} on none of 8 seeds`);
}

/** Tiky časového limitu světa (`time_limit`); hra bez něj by test nesplnila. */
function limitTicks(world: ArcadeWorld): number {
  const seconds = world.rules.find((rule) => rule.id === 'time_limit')?.params.seconds;
  if (typeof seconds !== 'number') throw new Error('the quest has no time limit');
  return seconds * 60;
}

/** Nečinný hráč: tik (počet odehraných tiků), kdy poprvé ubyl život, a jak a kdy běh skončil. */
function idleRun(world: ArcadeWorld, horizon: number): { readonly firstLoss: number | null; readonly losses: number[]; readonly end: number; readonly runState: number } {
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const health = HEADER.counters + COUNTER.health;
  const losses: number[] = [];
  while ((state[HEADER.tick] as number) < horizon && state[HEADER.runState] === RUN_STATE.running) {
    const before = state[health] as number;
    step(state, NO_INPUT, program);
    if ((state[health] as number) < before) losses.push(state[HEADER.tick] as number);
  }
  return { firstLoss: losses[0] ?? null, losses, end: state[HEADER.tick] as number, runState: state[HEADER.runState] as number };
}

/** Životy na konci záznamu robota. */
function livesAfter(world: ArcadeWorld, inputs: ReturnType<typeof runBot>['inputs']): number {
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  let next = 0;
  while (state[HEADER.runState] === RUN_STATE.running && (state[HEADER.tick] as number) < 90 * 60) {
    const tick = state[HEADER.tick] as number;
    const event = inputs[next];
    if (event !== undefined && event.tick === tick) next += 1;
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  return state[HEADER.counters + COUNTER.health] as number;
}

describe('quest danger – an idle player loses a life before the clock runs out, the robot still wins', () => {
  it.each(Object.keys(SENTENCES) as (keyof typeof SENTENCES)[])('%s: first life lost before the time limit, the run lost to the danger, the robot wins', (mode) => {
    const game = gameOf(draft(SENTENCES[mode]));
    const { world, bot } = publishedWorld(game);
    const limit = limitTicks(world);
    const idle = idleRun(world, limit + 60);
    expect(idle.firstLoss, `${mode}: the idle player lost no life before the clock`).not.toBeNull();
    expect(idle.firstLoss as number).toBeLessThan(limit);
    // Celý běh padne na nebezpečí, ne na hodinách: tři životy dřív, než limit doběhne.
    expect(idle.losses).toHaveLength(START_LIVES);
    expect([idle.runState, idle.end < limit]).toEqual([RUN_STATE.lost, true]);
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).outcome).toBe('won');
  });

  it('spatial: a sentence without a chase gets one default chaser, a spec without params too', () => {
    const drafted = draft(SENTENCES.spatial);
    expect(drafted.params?.chasers).toBe(DEFAULT_CHASERS);
    const bare: GenreSpecOf<'quest'> = { genre: 'quest', mode: 'spatial', hero: 'wizard', target: { label: 'candle', verb: 'light', states: 2 }, setting: 'castle' };
    for (const game of [gameOf(drafted), gameOf(bare)]) {
      expect(game.roles.find((role) => role.kind === 'chaser')?.count).toBe(DEFAULT_CHASERS);
      const { world } = publishedWorld(game);
      const state = instantiate(world);
      let chasers = 0;
      for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) if (state[bodyBase(body) + BODY.role] === ROLE.chaser) chasers += 1;
      expect(chasers).toBe(DEFAULT_CHASERS);
    }
    expect(gameOf(bare).objective.description).toBe('Light all 5 candle in each of 3 rounds before the hunter catches you.');
  });

  it('station: the robot never lets it boil over – it wins with every life', () => {
    const { world, bot } = publishedWorld(gameOf(draft(SENTENCES.station)));
    expect(livesAfter(world, bot.inputs)).toBe(START_LIVES);
  });
});

describe('station boil-over – the clock counts ticks without progress', () => {
  /** Jedno stanoviště přímo před hrdinou (jako palačinka v `quest.test.ts`), s životy nebo bez nich. */
  function pancake(health: number | undefined): ArcadeWorld {
    const params = questStation.params.parse({ count: 1, states: 3, hold: 30, after: 90, window: 60 });
    const parts = questStation.parts(1, params, health);
    const built = buildWorld({ seed: 1, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, ...(health === undefined ? {} : { health }) }, ARCADE_LIBRARY);
    if (!built.ok) throw new Error(built.issues.join('; '));
    return built.world;
  }

  it('an idle chef loses a life every 8 s and the run on the third', () => {
    expect(boilTicks(questStation.params.parse({}))).toBe(QUEST.boil);
    const idle = idleRun(pancake(START_LIVES), 90 * 60);
    expect(idle.losses).toEqual([QUEST.boil, 2 * QUEST.boil, 3 * QUEST.boil]);
    expect([idle.runState, idle.end]).toEqual([RUN_STATE.lost, 3 * QUEST.boil]);
  });

  it('a step resets the clock: pouring at 0.5 s moves the first boil-over to 0.5 s + 8 s', () => {
    const world = pancake(START_LIVES);
    const state = instantiate(world);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const health = HEADER.counters + COUNTER.health;
    // Nalít: 30 tiků držení posune stav 0 → 1 v tiku 30, pak už jen stát.
    for (let t = 0; t < 30; t += 1) step(state, { buttons: BUTTON.INTERACT, axis: 0 }, program);
    let lost = -1;
    while (lost < 0 && (state[HEADER.tick] as number) < 90 * 60) {
      const before = state[health] as number;
      step(state, NO_INPUT, program);
      if ((state[health] as number) < before) lost = state[HEADER.tick] as number;
    }
    expect(lost).toBe(30 + QUEST.boil);
  });

  it('without lives (a stored spec from before T2, remixed) the boil-over loses the run at once', () => {
    const idle = idleRun(pancake(undefined), 90 * 60);
    expect([idle.runState, idle.end, idle.losses]).toEqual([RUN_STATE.lost, QUEST.boil, []]);
  });
});
