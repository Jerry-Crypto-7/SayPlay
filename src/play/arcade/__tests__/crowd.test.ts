/**
 * Dav a brány (P54C T10): dav běží tratí, dvojice bran ve dvou pruzích ho mění, překážky ubírají a na konci se bije
 * s obrem. Hlídá společné brány žánru G1 (robot vyhraje 20/20 za 30–90 s), G2 (nečinný nevyhraje – dav uprostřed
 * neprojde žádnou branou a obra nepřeroste), G6 (čítač prošlých bran se pohne jen robotovi), G4/G5 a pásmo G3
 * na 20 semínkách, plus pravidla, která bez dozoru rozhodují o výsledku: znaménko a druh brány, překážka bere dav
 * a život, dav na nule prohrává, síla obra plyne z délky trati, robot volí bránu s větším výsledkem a pomalá
 * reakce nestihne přeběh, který robot světa stihne.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeEffect, type ArcadeInput, type ArcadeWorld, AXIS_MAX, BODY, BUTTON, COUNTER, FLAG, HEADER, type InputEvent, NO_INPUT, bodyBase, bodyHp, graceOf } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import {
  CROWD,
  type CrowdLayout,
  type Gate,
  OP,
  SWITCH_TICKS,
  applyGate,
  bossIndex,
  bossStrength,
  checkCrowdLevel,
  checkLayout,
  crowdLayout,
  crowdLevel,
  crowdOf,
  crowdWorldOf,
  greedyLanes,
  predictedTicks,
  switchNeed,
  walkPath,
} from '../pieces/crowd';
import { crowdBot, crowdProbeInput, wantedLane, type CrowdBotParams } from '../pieces/crowd-bot';
import { funMetrics, traceRun } from '../telemetry';
import { BOT_PROFILES, type BotProfile, runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '../../compose/allowed';
import { compileRecipe } from '../../compose/compile';
import { DIRECTOR_PENDING, GENRE_ANSWER_SCHEMA } from '../../director/answer-schema';
import { classifyGenre } from '../../genre/classify';
import { crowdGenre } from '../../genre/crowd';
import { compileGenre, readGenreSpec } from '../../genre/index';
import { readGameSpec } from '../../spec';

const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);
const S = CROWD.speed;

const cell = liveCells().find((candidate) => candidate.id === 'crowd.default');
const spec = cell === undefined ? null : compileRecipe(assemblyOfCell(cell));

function build(seed: number): ArcadeWorld {
  if (spec === null) throw new Error('crowd.default is not a live cell');
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

// Stavba trati a běh robota jsou nejdražší část souboru: brány je sdílejí (G4 staví znovu, aby porovnal).
const worlds = new Map<number, ArcadeWorld>();
const runs = new Map<number, ReturnType<typeof runBot>>();
function worldOf(seed: number): ArcadeWorld {
  const world = worlds.get(seed) ?? build(seed);
  worlds.set(seed, world);
  return world;
}
function botRun(seed: number): ReturnType<typeof runBot> {
  const run = runs.get(seed) ?? runBot(worldOf(seed));
  runs.set(seed, run);
  return run;
}

const items = (state: Int32Array): number => state[HEADER.counters + COUNTER.items] as number;
const health = (state: Int32Array): number => state[HEADER.counters + COUNTER.health] as number;
const score = (state: Int32Array): number => state[HEADER.counters + COUNTER.score] as number;
const heroX = (state: Int32Array): number => state[bodyBase(0) + BODY.x] as number;
const heroZ = (state: Int32Array): number => state[bodyBase(0) + BODY.z] as number;
const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

const add = (n: number): Gate => ({ op: OP.add, n });
const sub = (n: number): Gate => ({ op: OP.sub, n });
const mul: Gate = { op: OP.mul, n: 2 };
const div: Gate = { op: OP.div, n: 2 };

/** Ruční trať: dvojice bran po ticích, překážky, čára souboje a síla obra; bez komba a bonusu (ty přidá kompilátor specu). */
function handLayout(pairs: readonly (readonly [tick: number, left: Gate, right: Gate])[], options: { obstacles?: CrowdLayout['obstacles']; stopTick?: number; boss?: number } = {}): CrowdLayout {
  return {
    pairs: pairs.map(([tick, left, right]) => ({ tick, left, right })),
    obstacles: options.obstacles ?? [],
    stopTick: options.stopTick ?? (pairs.at(-1)?.[0] ?? 60) + 60,
    boss: options.boss ?? 3,
  };
}

function handWorld(layout: CrowdLayout, lives: number = CROWD.lives): ArcadeWorld {
  const parts = crowdWorldOf(layout, lives);
  const built = buildWorld({ seed: 1, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: lives }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Ruční trať s počítadlem komba za tělesy úrovně, jak ho přidá kompilátor (`withCombo`). */
function comboWorld(layout: CrowdLayout): ArcadeWorld {
  const parts = crowdWorldOf(layout, CROWD.lives);
  const keeper = parts.level.bodies.length;
  const level = { ...parts.level, bodies: [...parts.level.bodies, { role: 'thing' as const, kind: 'player', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true }] };
  const rules = parts.rules.map((ref) => (ref.id === 'crowd_gate' ? { ...ref, params: { ...ref.params, combo: keeper } } : ref));
  const built = buildWorld({ seed: 1, control: parts.control, rules, bot: parts.bot, level, health: CROWD.lives }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Stav po `ticks` tikech se vstupy podle tiku (stav po kroku `t` = `playFor(world, t + 1)`). */
function playFor(world: ArcadeWorld, ticks: number, plan: Readonly<Record<number, ArcadeInput>> = {}): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < ticks && outcomeOf(state) === 'running'; tick += 1) step(state, plan[tick] ?? NO_INPUT, program);
  return state;
}

/** Tik po tiku jako `replay`, se stavem, s tiky, ve kterých ubyl život, a s davem, se kterým hrdina došel na čáru souboje. */
function playRecord(world: ArcadeWorld, inputs: readonly InputEvent[]): { readonly state: Int32Array; readonly lifeTicks: number[]; readonly crowdAtStop: number } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const stop = world.control.params.stop as number;
  const lifeTicks: number[] = [];
  let crowdAtStop = -1;
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    const before = health(state);
    const crowd = crowdOf(state);
    const short = heroZ(state) < stop;
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    // Souboj začne už v kroku, který hrdinu na čáru dovezl: dav před ním.
    if (short && heroZ(state) >= stop) crowdAtStop = crowd;
    for (let lost = health(state); lost < before; lost += 1) lifeTicks.push(tick);
  }
  return { state, lifeTicks, crowdAtStop };
}

const LEFT: ArcadeInput = { buttons: 0, axis: -AXIS_MAX };
const RIGHT: ArcadeInput = { buttons: 0, axis: AXIS_MAX };

describe('crowd genre is live (P54C T10)', () => {
  it('has a live crowd.default cell, a ready module and the crowd generator', () => {
    expect(cell?.status).toBe('live');
    expect(crowdGenre.availability('default')).toBe('ready');
    expect(MODE_GENERATORS.crowd_track?.id).toBe('crowd_track');
    expect(spec?.control).toBe('crowd');
    expect(readGameSpec(spec).ok).toBe(true);
    expect(spec?.roles.find((role) => role.id === 'obstacle')?.label).toBe('saw');
    expect(spec?.roles.find((role) => role.id === 'boss')).toMatchObject({ kind: 'target', label: 'ogre' });
    expect(spec?.objective).toMatchObject({ kind: 'defeat_targets', count: 1, role: 'boss' });
    expect(spec?.mechanics.find((mechanic) => mechanic.id === 'health')?.params).toEqual({ max: CROWD.lives });
  });

  it('reads the obstacle and the boss from the sentence and keeps the copy short', () => {
    const fill = crowdGenre.draftFill('a crowd of penguins dodges saws and beats the giant at the end', null);
    expect(fill.cast?.find((item) => item.does === 'fight')?.label).toBe('giant');
    expect(fill.cast?.every((item) => item.does === 'avoid' || item.does === 'fight')).toBe(true);
    const read = readGenreSpec({ genre: 'crowd', mode: 'default', hero: 'penguin', setting: 'glacier', cast: [{ label: 'icicle', does: 'avoid' }, { label: 'yeti', does: 'fight' }] });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const game = compileGenre(read.value);
    expect(game.roles.find((role) => role.id === 'obstacle')?.label).toBe('icicle');
    expect(game.roles.find((role) => role.id === 'boss')?.label).toBe('yeti');
    expect(game.tutorial.goalLine.length).toBeLessThanOrEqual(50);
    expect(game.tutorial.goalLine).toContain('yeti');
  });

  // Věty k žánru vede od T13b klasifikátor; režisér ho nabídne až při opakování T14 (T14b).
  it('is chosen by the classifier (T13b) and the director does not offer it yet', () => {
    for (const sentence of ['a crowd runs through gates and fights a giant', 'count masters with penguins', 'grow your army through math gates']) {
      expect(classifyGenre(sentence, null).ranked[0]?.genre, sentence).toBe('crowd');
    }
    expect(DIRECTOR_PENDING.has('crowd')).toBe(true);
    const variants = (GENRE_ANSWER_SCHEMA.properties as Record<string, { anyOf: { properties: Record<string, { enum?: unknown[] }> }[] }>).spec.anyOf;
    expect(variants.flatMap((variant) => variant.properties.genre?.enum ?? [])).not.toContain('crowd');
  });
});

describe('crowd control', () => {
  const world = handWorld(handLayout([[200, add(1), add(2)]]));

  it('runs forward at a steady speed and starts in the middle', () => {
    const state = playFor(world, 10);
    expect(heroZ(state)).toBe(10 * S);
    expect(heroX(state)).toBe(0);
  });

  it('the sign of the axis or the arrows pick a lane; the hero crosses at the lateral speed and stays there', () => {
    expect(heroX(playFor(world, 3, { 0: LEFT }))).toBe(-3 * CROWD.lateral);
    expect(heroX(playFor(world, 30, { 0: RIGHT }))).toBe(CROWD.laneX);
    expect(heroX(playFor(world, 30, { 0: { buttons: BUTTON.LEFT, axis: 0 } }))).toBe(-CROWD.laneX);
    // Bez vstupu pruh drží: zpátky doprostřed se nevrátí.
    expect(heroX(playFor(world, 60, { 0: LEFT, 20: NO_INPUT }))).toBe(-CROWD.laneX);
    expect(heroX(playFor(world, 60, { 0: LEFT, 20: RIGHT }))).toBe(CROWD.laneX);
  });

  it('stops on the fight line', () => {
    const stop = handWorld(handLayout([[60, add(1), add(2)]], { stopTick: 100, boss: 400 }));
    expect(heroZ(playFor(stop, 150))).toBe(100 * S);
  });
});

describe('crowd gates', () => {
  // Dvojice v tiku 60: hrdina ji projde v kroku 59.
  const signs = handWorld(handLayout([[60, sub(3), add(10)]]));

  it('a negative gate subtracts and a positive one adds, on the step the hero passes it', () => {
    expect(crowdOf(playFor(signs, 59, { 0: LEFT }))).toBe(CROWD.start);
    expect(crowdOf(playFor(signs, 60, { 0: LEFT }))).toBe(CROWD.start - 3);
    expect(crowdOf(playFor(signs, 60, { 0: RIGHT }))).toBe(CROWD.start + 10);
  });

  it('×2 doubles and ÷2 halves (rounded down)', () => {
    const world = handWorld(handLayout([[60, mul, div]]));
    expect(crowdOf(playFor(world, 60, { 0: LEFT }))).toBe(2 * CROWD.start);
    expect(crowdOf(playFor(world, 60, { 0: RIGHT }))).toBe(Math.floor(CROWD.start / 2));
    expect([applyGate(OP.add, 4, 7), applyGate(OP.mul, 2, 7), applyGate(OP.sub, 9, 7), applyGate(OP.div, 2, 7)]).toEqual([11, 14, 0, 3]);
  });

  it('the middle passes no gate: the crowd and the gate counter stay', () => {
    const state = playFor(signs, 80);
    expect(crowdOf(state)).toBe(CROWD.start);
    expect(items(state)).toBe(0);
    expect(items(playFor(signs, 80, { 0: RIGHT }))).toBe(1);
  });

  it('a crowd that reaches zero at a gate loses on that step', () => {
    const world = handWorld(handLayout([[60, sub(9), add(1)]]));
    expect(outcomeOf(playFor(world, 59, { 0: LEFT }))).toBe('running');
    const lost = playFor(world, 60, { 0: LEFT });
    expect(outcomeOf(lost)).toBe('lost');
    expect(crowdOf(lost)).toBe(0);
  });

  it('a growing gate scores and raises the combo of the live world, a shrinking one drops it', () => {
    const world = worldOf(5);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const inputs = botRun(5).inputs;
    const multipliers: number[] = [];
    let next = 0;
    for (let tick = 0; outcomeOf(state) === 'running' && tick < ARCADE_LIMITS.maxTicks; tick += 1) {
      while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
      const effects: readonly ArcadeEffect[] = step(state, inputs[next]?.tick === tick ? (inputs[next] as InputEvent) : NO_INPUT, program);
      for (const effect of effects) if (effect.kind === 'combo') multipliers.push(effect.multiplier);
    }
    // Robot volí jen rostoucí brány: série jde ×1, ×2, … ×5 a drží.
    expect(multipliers.slice(0, 6)).toEqual([1, 2, 3, 4, 5, 5]);
    // Ruční trať s počítadlem komba: tři rostoucí brány za sebou ×1 + ×2 + ×3, úbytek mezi nimi sérii shodí.
    const combo = comboWorld(handLayout([[60, add(4), sub(2)], [120, add(4), sub(2)], [180, add(4), add(1)]]));
    expect(score(playFor(combo, 200, { 0: LEFT }))).toBe(6 * CROWD.points);
    expect(score(playFor(combo, 200, { 0: LEFT, 70: RIGHT, 140: LEFT }))).toBe(2 * CROWD.points);
  });
});

describe('crowd obstacles', () => {
  // Překážka vlevo v tiku 90 (mezi dvojicemi v tiku 60 a 120), bere 4.
  const layout = handLayout([[60, add(10), add(1)], [120, add(1), add(1)]], { obstacles: [{ tick: 90, lane: -1, loss: 4 }] });
  const world = handWorld(layout);

  it('an obstacle takes its share of the crowd and a life on contact, then is gone; grace follows', () => {
    const run = playRecord(world, [{ tick: 0, ...LEFT }]);
    expect(run.lifeTicks).toHaveLength(1);
    const hit = run.lifeTicks[0] as number;
    const before = playFor(world, hit, { 0: LEFT });
    const after = playFor(world, hit + 1, { 0: LEFT });
    expect(crowdOf(before)).toBe(CROWD.start + 10);
    expect(crowdOf(after)).toBe(CROWD.start + 10 - 4);
    expect(health(after)).toBe(CROWD.lives - 1);
    expect(alive(after, 1)).toBe(false);
    expect(graceOf(after, 0)).toBeGreaterThan(0);
    // V druhém pruhu překážka nic nevezme.
    const right = playFor(world, 150, { 0: RIGHT });
    expect(health(right)).toBe(CROWD.lives);
    expect(alive(right, 1)).toBe(true);
  });

  it('an obstacle that empties the crowd loses the game; the last life lost loses it too', () => {
    const wipe = handWorld(handLayout([[60, add(1), add(1)], [120, add(1), add(1)]], { obstacles: [{ tick: 90, lane: -1, loss: 20 }] }));
    expect(outcomeOf(playFor(wipe, 150, { 0: LEFT }))).toBe('lost');
    expect(crowdOf(playFor(wipe, 150, { 0: LEFT }))).toBe(0);
    const oneLife = handWorld(layout, 1);
    expect(outcomeOf(playFor(oneLife, 150, { 0: LEFT }))).toBe('lost');
    expect(outcomeOf(playFor(world, 150, { 0: LEFT }))).toBe('running');
  });
});

describe('crowd finale', () => {
  it('the crowd fights the boss on the fight line: a bigger crowd wins, a smaller or equal one loses', () => {
    const big = handWorld(handLayout([[60, add(10), add(1)]], { stopTick: 120, boss: 12 }));
    const won = playFor(big, 400, { 0: LEFT });
    expect(outcomeOf(won)).toBe('won');
    expect(crowdOf(won)).toBe(CROWD.start + 10 - 12);
    // Souboj začne až na čáře: krok 118 (z pod čarou) dav ještě nezmenší.
    expect(crowdOf(playFor(big, 119, { 0: RIGHT }))).toBe(CROWD.start + 1);
    const small = playFor(big, 400, { 0: RIGHT });
    expect(outcomeOf(small)).toBe('lost');
    expect(crowdOf(small)).toBe(0);
    // Remíza (dav = síla obra) je prohra: dav došel na nulu.
    const even = handWorld(handLayout([[60, add(10), add(1)]], { stopTick: 120, boss: CROWD.start + 10 }));
    expect(outcomeOf(playFor(even, 400, { 0: LEFT }))).toBe('lost');
  });

  it('the boss takes hits, falls and is the finale of the run (P51 telemetry)', () => {
    const layout = handLayout([[60, add(30), add(1)]], { stopTick: 120, boss: 20 });
    const world = handWorld(layout);
    const boss = bossIndex(layout);
    expect(bodyHp(instantiate(world), boss)).toBe(20);
    const won = playFor(world, 400, { 0: LEFT });
    expect(alive(won, boss)).toBe(false);
    expect(funMetrics(traceRun(world, [{ tick: 0, ...LEFT }])).finale).toEqual({ present: true, why: 'boss' });
  });

  it('the boss strength comes from the length of the track', () => {
    expect(bossStrength(2000)).toBe(Math.round((2000 * S * CROWD.boss.perMetre) / 1_000_000));
    expect(bossStrength(2400)).toBeGreaterThan(bossStrength(2000));
    for (const seed of [1, 2, 3]) {
      const layout = crowdLayout(seed);
      expect(layout.boss).toBe(bossStrength(layout.stopTick));
      expect(crowdLevel(layout).bodies[bossIndex(layout)]?.hp).toBe(layout.boss);
    }
  });
});

describe('crowd track is playable by construction', () => {
  it('passes its own check on 20 seeds; the greedy crowd beats the boss, the middle and either side alone do not', () => {
    for (const seed of SEEDS) {
      const layout = crowdLayout(seed);
      expect(checkCrowdLevel(crowdLevel(layout), layout), `seed ${seed}`).toEqual([]);
      const lanes = greedyLanes(layout);
      expect(walkPath(layout, (index) => lanes[index] as number).crowd, `seed ${seed}`).toBeGreaterThan(layout.boss);
      for (const side of [-1, 1]) {
        const end = walkPath(layout, () => side);
        expect(end.wiped || end.crowd <= layout.boss, `seed ${seed} side ${side}`).toBe(true);
      }
      const ticks = predictedTicks(layout);
      expect(ticks).toBeGreaterThanOrEqual(CROWD.shortest);
      expect(ticks).toBeLessThanOrEqual(CROWD.longest);
    }
  });

  it('fails its check when a switch is too quick for the bot, an obstacle stands in its lane or the crowd falls short', () => {
    const layout = crowdLayout(1);
    const lanes = greedyLanes(layout);
    const at = lanes.findIndex((lane, index) => index > 0 && lane !== lanes[index - 1]);
    const need = switchNeed(CROWD.reaction) + CROWD.reserve;
    const rushed: CrowdLayout = { ...layout, pairs: layout.pairs.map((pair, index) => (index >= at ? { ...pair, tick: pair.tick - ((layout.pairs[at] as typeof pair).tick - (layout.pairs[at - 1] as typeof pair).tick) + need - 1 } : pair)) };
    expect(checkLayout(rushed).join(' ')).toMatch(/needs a switch in/);
    const before = layout.pairs[at - 1] as (typeof layout.pairs)[number];
    const blocking: CrowdLayout = { ...layout, obstacles: [...layout.obstacles, { tick: before.tick + 5, lane: lanes[at - 1] as -1 | 1, loss: 3 }].sort((a, b) => a.tick - b.tick) };
    expect(checkLayout(blocking).join(' ')).toMatch(/stands in the bot's lane/);
    expect(checkLayout({ ...layout, boss: layout.boss * 2 }).join(' ')).toMatch(/greedy crowd/);
    const generous: CrowdLayout = { ...layout, obstacles: [], pairs: layout.pairs.map((pair) => ({ ...pair, left: add(20), right: add(20) })) };
    expect(checkLayout(generous).join(' ')).toMatch(/holding the left lane beats the boss/);
  });
});

describe('crowd bot', () => {
  it('picks the gate with the bigger result for the crowd it has', () => {
    // Dav 5: +8 (13) je víc než ×2 (10). Dav 15 (po +10): ×2 (30) je víc než +8 (23).
    const params = (gates: CrowdBotParams['gates']): CrowdBotParams => ({ gates, stop: 100_000 });
    const world = handWorld(handLayout([[60, add(8), mul]]));
    const observation = { state: instantiate(world), player: 0, tick: 0, recent: [] };
    expect(wantedLane(observation, params([[60 * S, OP.add, 8, OP.mul, 2]]))).toBe(-1);
    const state = instantiate(world);
    state[HEADER.counters + COUNTER.reserve] = 15;
    expect(wantedLane({ ...observation, state }, params([[60 * S, OP.add, 8, OP.mul, 2]]))).toBe(1);
    expect(wantedLane({ ...observation, state }, params([[60 * S, OP.sub, 3, OP.div, 2]]))).toBe(-1);
    const run = runBot(world);
    expect(crowdOf(playRecord(world, run.inputs).state)).toBeGreaterThan(0);
    expect(items(playFor(world, 70, Object.fromEntries(run.inputs.map((input) => [input.tick, input]))))).toBe(1);
    expect(crowdOf(playFor(world, 70, Object.fromEntries(run.inputs.map((input) => [input.tick, input]))))).toBe(CROWD.start + 8);
  });

  it('makes a switch in exactly the time its reaction allows; a slower reaction misses it', () => {
    // Dvojice v tiku 60: lepší vpravo; dvojice o Δ později: lepší vlevo.
    const need = switchNeed(CROWD.reaction);
    expect(need).toBe(CROWD.reaction + SWITCH_TICKS);
    const taken = (gap: number, profile?: BotProfile): number => {
      const world = handWorld(handLayout([[60, add(1), add(10)], [60 + gap, add(10), add(1)]], { boss: 1 }));
      const run = runBot(world, undefined, profile === undefined ? {} : { profile });
      const program = loadProgram(world, ARCADE_LIBRARY);
      const state = instantiate(world);
      let next = 0;
      for (let tick = 0; tick < 60 + gap; tick += 1) {
        while (next < run.inputs.length && (run.inputs[next] as InputEvent).tick < tick) next += 1;
        step(state, run.inputs[next]?.tick === tick ? (run.inputs[next] as InputEvent) : NO_INPUT, program);
      }
      return crowdOf(state);
    };
    expect(taken(need)).toBe(CROWD.start + 20);
    expect(taken(need - 1)).toBeLessThan(CROWD.start + 20);
    // Začátečník vidí o 12 tiků později: týž přeběh nestihne.
    expect(BOT_PROFILES.novice.extraReactionTicks).toBe(12);
    expect(taken(need + 6, 'novice')).toBeLessThan(CROWD.start + 20);
  });

  it('runs around an obstacle in the lane it wants', () => {
    const world = handWorld(handLayout([[60, add(1), add(9)], [140, add(1), add(9)]], { obstacles: [{ tick: 100, lane: 1, loss: 3 }] }));
    const run = runBot(world);
    expect(playRecord(world, run.inputs).lifeTicks).toEqual([]);
    expect(items(playFor(world, 150, Object.fromEntries(run.inputs.map((input) => [input.tick, input]))))).toBe(2);
  });

  it('the threat probe turns into an obstacle close ahead', () => {
    const world = handWorld(handLayout([[60, add(1), add(9)], [140, add(1), add(9)]], { obstacles: [{ tick: 100, lane: -1, loss: 3 }] }));
    const state = playFor(world, 70, { 0: RIGHT });
    const observation = { state, player: 0, tick: 70, recent: [] };
    expect(crowdProbeInput(observation, 1, NO_INPUT)).toEqual({ buttons: 0, axis: -AXIS_MAX });
    expect(crowdProbeInput({ ...observation, state: playFor(world, 20, { 0: RIGHT }) }, 1, NO_INPUT)).toEqual(NO_INPUT);
  });

  it('the bot piece is registered and reacts like the course check assumes', () => {
    expect(ARCADE_LIBRARY.bots.crowd_bot).toBe(crowdBot);
    expect(crowdBot.reactionTicks).toBe(CROWD.reaction);
  });
});

describe('crowd gates on the live cell (G1, G2, G4, G5, G6)', () => {
  it('G1: the world bot wins on all 20 seeds in 30–90 s and never loses a life', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const run = botRun(seed);
      expect(run.outcome, `seed ${seed}`).toBe('won');
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeGreaterThanOrEqual(30);
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeLessThanOrEqual(90);
      expect(playRecord(world, run.inputs).lifeTicks, `seed ${seed}`).toEqual([]);
    }
  });

  it('G2 + G6: an idle crowd passes no gate and loses to the boss; the bot takes every gate and grows', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const idle = playRecord(world, []);
      expect(outcomeOf(idle.state), `seed ${seed}`).toBe('lost');
      expect(items(idle.state), `seed ${seed}`).toBe(0);
      expect(idle.crowdAtStop, `seed ${seed}`).toBe(CROWD.start);
      expect(idle.lifeTicks, `seed ${seed}`).toEqual([]);
      const bot = playRecord(world, botRun(seed).inputs);
      expect(items(bot.state), `seed ${seed}`).toBe(CROWD.pairs);
      expect(bot.crowdAtStop, `seed ${seed}`).toBeGreaterThan(CROWD.start);
    }
  });

  it('G4: the same seed builds the same world and the bot record replays to its hash', () => {
    for (const seed of [1, 7, 20]) {
      expect(canonicalHash(build(seed))).toBe(canonicalHash(worldOf(seed)));
      const run = botRun(seed);
      expect(replay(worldOf(seed), run.inputs, ARCADE_LIBRARY).hash).toBe(run.hash);
    }
    expect(canonicalHash(worldOf(1))).not.toBe(canonicalHash(worldOf(2)));
  });

  it('G5: lives, the gate combo and the end bonus are in the live world', () => {
    const world = worldOf(3);
    expect(world.initial[HEADER.counters + COUNTER.health]).toBe(CROWD.lives);
    expect(world.rules.find((ref) => ref.id === 'crowd_gate')?.params.combo).toBeTypeOf('number');
    expect(world.rules.some((ref) => ref.id === 'score_bonus')).toBe(true);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const inputs = botRun(3).inputs;
    let best = 1;
    let next = 0;
    for (let tick = 0; outcomeOf(state) === 'running' && tick < ARCADE_LIMITS.maxTicks; tick += 1) {
      while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
      const effects: readonly ArcadeEffect[] = step(state, inputs[next]?.tick === tick ? (inputs[next] as InputEvent) : NO_INPUT, program);
      for (const effect of effects) if (effect.kind === 'combo') best = Math.max(best, effect.multiplier);
    }
    expect(outcomeOf(state)).toBe('won');
    expect(best).toBeGreaterThanOrEqual(3);
    expect(funMetrics(traceRun(world, inputs)).finale).toEqual({ present: true, why: 'boss' });
  });

  it('witnesses crowd and defeat in the bot run, and the obstacle harms in its probe', () => {
    if (spec === null) throw new Error('crowd.default is not a live cell');
    const made = arcadeWorldOf(spec, 2);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    const verbs = new Set(verdict.witnesses.map((witness) => witness.verb));
    for (const verb of ['crowd', 'defeat', 'obstacle']) expect(verbs.has(verb), verb).toBe(true);
    expect(verdict.failures).toEqual([]);
  });
});

describe('crowd difficulty band (G3 on 20 seeds; the gate itself is difficulty.test.ts)', () => {
  const rate = (profile: BotProfile): number => SEEDS.filter((seed) => runBot(worldOf(seed), undefined, { profile }).outcome === 'won').length / SEEDS.length;
  it('novice wins 0.3–0.7, intermediate at least 0.8', () => {
    expect(Object.keys(BOT_PROFILES)).toEqual(['novice', 'intermediate']);
    const novice = rate('novice');
    const intermediate = rate('intermediate');
    expect(novice, `novice ${novice}`).toBeGreaterThanOrEqual(0.3);
    expect(novice, `novice ${novice}`).toBeLessThanOrEqual(0.7);
    expect(intermediate, `intermediate ${intermediate}`).toBeGreaterThanOrEqual(0.8);
  });
});
