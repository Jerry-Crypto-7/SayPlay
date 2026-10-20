/**
 * Přeskákání silnice (P54C T9): hrdina skáče po polích přes silnice, řeky a koleje. Hlídá společné brány žánru
 * G1 (robot vyhraje 20/20 za 30–90 s), G2 (nečinný nevyhraje – vezme ho orel), G6 (čítač řad se pohne jen robotovi),
 * G4/G5 a pásmo G3 na 20 semínkách, plus pravidla, která bez dozoru rozhodují o životech: auto a voda bez klády berou
 * život v tom tiku a vracejí na poslední trávu, kláda veze a za hranou pole stojí život, orel bere nečinného,
 * trať je hratelná z konstrukce a robot s delší reakcí přehlédne auto, které právě vjelo.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeEffect, type ArcadeInput, type ArcadeWorld, BODY, BUTTON, COUNTER, HEADER, type InputEvent, NO_INPUT, bodyBase, graceOf } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import {
  HOP,
  HOP_BODIES,
  HOP_HALF,
  type HopLane,
  type HopLayout,
  ROW,
  bandLanesOf,
  bandWait,
  checkHopLevel,
  hopLayout,
  hopLeft,
  hopLevel,
  hopParams,
  hopWorldOf,
  idleTicks,
  laneClear,
  predictedTicks,
} from '../pieces/hop';
import { hopBot, hopProbeInput, planHop, type HopBotParams } from '../pieces/hop-bot';
import { BOT_PROFILES, type BotProfile, runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '../../compose/allowed';
import { compileRecipe } from '../../compose/compile';
import { DIRECTOR_PENDING, GENRE_ANSWER_SCHEMA } from '../../director/answer-schema';
import { classifyGenre } from '../../genre/classify';
import { hopGenre } from '../../genre/hop';
import { compileGenre, readGenreSpec } from '../../genre/index';
import { readGameSpec } from '../../spec';

const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);
const DEFAULTS = hopParams.parse({});
const H = HOP.hopTicks;
const CELL = HOP.cell;

const cell = liveCells().find((candidate) => candidate.id === 'hop.default');
const spec = cell === undefined ? null : compileRecipe(assemblyOfCell(cell));

function build(seed: number): ArcadeWorld {
  if (spec === null) throw new Error('hop.default is not a live cell');
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
const heroZ = (state: Int32Array): number => state[bodyBase(0) + BODY.z] as number;
const heroX = (state: Int32Array): number => state[bodyBase(0) + BODY.x] as number;

/** Ruční trať: druhy řad (poslední je cíl) a pruhy; bez komba a bonusu (ty přidá až kompilátor specu). */
function handWorld(kinds: readonly number[], lanes: readonly HopLane[] = [], lives = HOP.lives): ArcadeWorld {
  const layout: HopLayout = { kinds, lanes, bands: [] };
  const parts = hopWorldOf(layout, lives);
  const built = buildWorld({ seed: 1, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: lives }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const grass = (rows: number): number[] => Array.from({ length: rows + 1 }, () => ROW.grass);

/** Pruh s jedním vozidlem za periodu, jehož střed projede prostředním sloupcem po kroku `atMiddle`. */
function laneThrough(row: number, kind: 1 | 2 | 3, atMiddle: number, options: { speed: number; w: number; d: number; template: number; dir?: 1 | -1; period?: number }): HopLane {
  const entry = HOP_HALF + options.w / 2 + HOP.margin;
  const sent = atMiddle - entry / options.speed;
  if (!Number.isInteger(sent)) throw new Error('pick a speed that divides the entry distance');
  const period = options.period ?? 2000;
  return { row, kind, template: options.template, w: options.w, d: options.d, dir: options.dir ?? 1, speed: options.speed, period, phase: ((sent % period) + period) % period, warm: 0, entry, exit: entry };
}
const car = (row: number, atMiddle: number, speed = 150): HopLane => laneThrough(row, ROW.road, atMiddle, { speed, w: HOP.car.w, d: HOP.car.d, template: HOP_BODIES.car });
const log = (row: number, atMiddle: number, speed = 50): HopLane => laneThrough(row, ROW.river, atMiddle, { speed, w: HOP.logs[2], d: HOP.log.d, template: HOP_BODIES.log4 });

/** Stav po `ticks` tikech se vstupy podle tiku (stav po kroku `t` = `playFor(world, t + 1)`). */
function playFor(world: ArcadeWorld, ticks: number, plan: Readonly<Record<number, ArcadeInput>> = {}): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < ticks && outcomeOf(state) === 'running'; tick += 1) step(state, plan[tick] ?? NO_INPUT, program);
  return state;
}

const TAP: ArcadeInput = { buttons: BUTTON.TAP, axis: 0 };
const press = (buttons: number): ArcadeInput => ({ buttons, axis: 0 });

/** Tik po tiku jako `replay`, se stavem a se záznamem tiků, ve kterých ubyl život. */
function playRecord(world: ArcadeWorld, inputs: readonly InputEvent[]): { readonly state: Int32Array; readonly lifeTicks: number[] } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const lifeTicks: number[] = [];
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    const before = health(state);
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    for (let lost = health(state); lost < before; lost += 1) lifeTicks.push(tick);
  }
  return { state, lifeTicks };
}

describe('hop genre is live (P54C T9)', () => {
  it('has a live hop.default cell, a ready module and the hop generator', () => {
    expect(cell?.status).toBe('live');
    expect(hopGenre.availability('default')).toBe('ready');
    expect(MODE_GENERATORS.hop_rows?.id).toBe('hop_rows');
    expect(spec?.control).toBe('hop');
    expect(readGameSpec(spec).ok).toBe(true);
    expect(spec?.roles.find((role) => role.id === 'obstacle')?.label).toBe('car');
    expect(spec?.roles.find((role) => role.id === 'finish')?.kind).toBe('exit');
    expect(spec?.objective).toMatchObject({ kind: 'reach', count: HOP.rows.default, role: 'finish' });
    expect(spec?.mechanics.find((mechanic) => mechanic.id === 'health')?.params).toEqual({ max: HOP.lives });
  });

  it('reads the traffic and the goal from the sentence and keeps the row goal in bounds', () => {
    const fill = hopGenre.draftFill('a chicken crosses the busy road to reach the barn while dodging trucks', null);
    expect(fill.cast?.every((item) => item.does === 'avoid' || item.does === 'reach')).toBe(true);
    const read = readGenreSpec({ genre: 'hop', mode: 'default', hero: 'frog', setting: 'swamp', cast: [{ label: 'taxi', does: 'avoid' }, { label: 'lily pond', does: 'reach' }], params: { rows: 12 } });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const game = compileGenre(read.value);
    expect(game.roles.find((role) => role.id === 'obstacle')?.label).toBe('taxi');
    expect(game.roles.find((role) => role.id === 'finish')?.label).toBe('lily pond');
    expect((game.controlParams as { tuning: { rows: number } }).tuning.rows).toBe(12);
    expect(game.tutorial.goalLine.length).toBeLessThanOrEqual(50);
    expect(readGenreSpec({ genre: 'hop', mode: 'default', hero: 'fox', setting: 'forest', params: { rows: HOP.rows.max + 1 } }).ok).toBe(false);
  });

  // Věty k žánru povede až T13b a režisér ho nabídne až při opakování T14.
  it('is not chosen by the classifier yet and the director does not offer it', () => {
    for (const sentence of ['a chicken crosses the busy road', 'crossy road with a frog', 'hop across the river on logs']) {
      expect(classifyGenre(sentence, null).ranked[0]?.genre, sentence).not.toBe('hop');
    }
    expect(DIRECTOR_PENDING.has('hop')).toBe(true);
    const variants = (GENRE_ANSWER_SCHEMA.properties as Record<string, { anyOf: { properties: Record<string, { enum?: unknown[] }> }[] }>).spec.anyOf;
    expect(variants.flatMap((variant) => variant.properties.genre?.enum ?? [])).not.toContain('hop');
  });
});

describe('hop control', () => {
  it('a tap hops one cell forward in hopTicks ticks; input during a hop is ignored', () => {
    const world = handWorld(grass(5));
    expect(heroZ(playFor(world, H / 2, { 0: TAP }))).toBe(CELL / 2);
    expect(hopLeft(playFor(world, H / 2, { 0: TAP }), 0)).toBe(H / 2);
    expect(heroZ(playFor(world, H, { 0: TAP }))).toBe(CELL);
    // Ťuk uprostřed skoku se nečte: po dvou délkách skoku je hrdina pořád o jednu řadu dál.
    expect(heroZ(playFor(world, 2 * H, { 0: TAP, [H / 2]: TAP }))).toBe(CELL);
    expect(heroZ(playFor(world, 2 * H, { 0: TAP, [H]: TAP }))).toBe(2 * CELL);
  });

  it('hops sideways with the arrows or the axis, back with DOWN, and never off the field or behind the start', () => {
    const world = handWorld(grass(5));
    expect(heroX(playFor(world, H, { 0: press(BUTTON.RIGHT) }))).toBe(CELL);
    expect(heroX(playFor(world, H, { 0: { buttons: 0, axis: -1000 } }))).toBe(-CELL);
    expect(heroZ(playFor(world, H, { 0: press(BUTTON.DOWN) }))).toBe(0);
    expect(heroZ(playFor(world, 2 * H, { 0: TAP, [H]: press(BUTTON.DOWN) }))).toBe(0);
    const left = { 0: press(BUTTON.LEFT), [H]: press(BUTTON.LEFT), [2 * H]: press(BUTTON.LEFT), [3 * H]: press(BUTTON.LEFT), [4 * H]: press(BUTTON.LEFT) };
    expect(heroX(playFor(world, 5 * H, left))).toBe(-((HOP.cols - 1) / 2) * CELL);
  });

  it('counts the ticks without a hop and resets them on a hop', () => {
    const world = handWorld(grass(5));
    expect(idleTicks(playFor(world, 100), 0)).toBe(100);
    expect(idleTicks(playFor(world, 100, { 50: TAP }), 0)).toBe(100 - 50 - H);
  });
});

describe('hop rules', () => {
  it('counts each new farthest row once (at the middle of the hop); going back and forth adds nothing', () => {
    const world = handWorld(grass(5));
    expect(items(playFor(world, H / 2, { 0: TAP }))).toBe(1);
    expect(items(playFor(world, H / 2 - 1, { 0: TAP }))).toBe(0);
    expect(items(playFor(world, 4 * H, { 0: TAP, [H]: press(BUTTON.DOWN), [2 * H]: TAP, [3 * H]: TAP }))).toBe(2);
  });

  // Hrdina skočí v tiku 16 z trávy (řada 1) do silnice (řada 2); auto projede prostředním sloupcem po kroku 28.
  const ROAD_HIT = handWorld([ROW.grass, ROW.grass, ROW.road, ROW.grass, ROW.grass, ROW.grass], [car(2, 28)]);
  const intoRoad = { 0: TAP, [H]: TAP };

  it('a car takes a life on the very tick it touches the hero, sends him back to the last grass row and gives a second of grace', () => {
    const run = playRecord(ROAD_HIT, [{ tick: 0, ...TAP }, { tick: H, ...TAP }]);
    expect(run.lifeTicks).toHaveLength(1);
    const hit = run.lifeTicks[0] as number;
    // V řadě silnice je hrdina od osmého kroku skoku; auto ho zasáhne hned první takový tik.
    expect(hit).toBe(H + 7);
    expect(health(playFor(ROAD_HIT, hit, intoRoad))).toBe(HOP.lives);
    const after = playFor(ROAD_HIT, hit + 1, intoRoad);
    expect(health(after)).toBe(HOP.lives - 1);
    expect(heroZ(after)).toBe(CELL);
    expect(heroX(after)).toBe(0);
    expect(graceOf(after, 0)).toBeGreaterThan(0);
    // Skok, do kterého náraz vletěl, skončil: hrdina stojí na trávě.
    expect(heroZ(playFor(ROAD_HIT, hit + 5, intoRoad))).toBe(CELL);
    // Bez skoku do silnice auto projede a nic nevezme.
    expect(health(playFor(ROAD_HIT, 200, { 0: TAP }))).toBe(HOP.lives);
  });

  it('water without a log takes a life on the landing tick and sends the hero back', () => {
    const world = handWorld([ROW.grass, ROW.grass, ROW.river, ROW.grass, ROW.grass, ROW.grass], [log(2, 600)]);
    const landing = 2 * H - 1;
    expect(health(playFor(world, landing, intoRoad))).toBe(HOP.lives);
    const after = playFor(world, landing + 1, intoRoad);
    expect(health(after)).toBe(HOP.lives - 1);
    expect(heroZ(after)).toBe(CELL);
  });

  it('a log under the landing carries the hero; carried past the edge of the field costs a life', () => {
    const landing = 2 * H - 1;
    const world = handWorld([ROW.grass, ROW.grass, ROW.river, ROW.grass, ROW.grass, ROW.grass], [log(2, landing)]);
    const ride = playFor(world, landing + 1 + 40, intoRoad);
    expect(health(ride)).toBe(HOP.lives);
    expect(heroZ(ride)).toBe(2 * CELL);
    expect(heroX(ride)).toBe(40 * 50);
    // Střed klády (a s ním hrdina) minul hranu pole po kroku `landing + HALF / 50`.
    const edge = landing + HOP_HALF / 50 + 1;
    expect(health(playFor(world, edge, intoRoad))).toBe(HOP.lives);
    const off = playFor(world, edge + 1, intoRoad);
    expect(health(off)).toBe(HOP.lives - 1);
    expect(heroZ(off)).toBe(CELL);
  });

  it('the eagle takes a hero who has not hopped for six seconds; a hop in time keeps him in the game', () => {
    const world = handWorld(grass(5));
    expect(outcomeOf(playFor(world, HOP.eagle - 1))).toBe('running');
    const taken = playFor(world, HOP.eagle);
    expect(outcomeOf(taken)).toBe('lost');
    expect(health(taken)).toBe(HOP.lives);
    expect(outcomeOf(playFor(world, HOP.eagle + 60, { [HOP.eagle - 60]: press(BUTTON.RIGHT) }))).toBe('running');
  });

  it('wins on the landing that reaches the goal row', () => {
    const world = handWorld(grass(3));
    const plan = { 0: TAP, [H]: TAP, [2 * H]: TAP };
    expect(outcomeOf(playFor(world, 3 * H - 1, plan))).toBe('running');
    const won = playFor(world, 3 * H, plan);
    expect(outcomeOf(won)).toBe('won');
    expect(items(won)).toBe(3);
  });
});

describe('hop course is playable by construction', () => {
  it('passes its own check on 20 seeds for short, default and long goals', () => {
    for (const seed of SEEDS) for (const rows of [HOP.rows.min, 30, HOP.rows.max]) {
      const params = hopParams.parse({ rows });
      const layout = hopLayout(seed, params);
      expect(checkHopLevel(hopLevel(layout), layout, params), `seed ${seed}, ${rows} rows`).toEqual([]);
    }
  });

  it('starts and ends on grass, has grass before every band, and the world bot needs 34–80 s by the course itself', () => {
    const kinds = new Set<number>();
    for (const seed of SEEDS) {
      const layout = hopLayout(seed, DEFAULTS);
      expect(layout.kinds.slice(0, HOP.startGrass).every((kind) => kind === ROW.grass), `seed ${seed}`).toBe(true);
      expect(layout.kinds.at(-1)).toBe(ROW.grass);
      for (const band of layout.bands) expect(layout.kinds[band.first - 1], `seed ${seed} band ${band.first}`).toBe(ROW.grass);
      const ticks = predictedTicks(layout);
      expect(ticks, `seed ${seed}`).toBeGreaterThanOrEqual(HOP.shortest);
      expect(ticks, `seed ${seed}`).toBeLessThanOrEqual(HOP.longest);
      for (const kind of layout.kinds) kinds.add(kind);
    }
    expect(kinds).toEqual(new Set([ROW.grass, ROW.road, ROW.river, ROW.rail]));
  });

  it('fails its check when a band has no crossing, a lane is pre-rolled too late or the start is not grass', () => {
    const layout = hopLayout(1, DEFAULTS);
    const params = DEFAULTS;
    const band = layout.bands.find((candidate) => candidate.kind === ROW.road) as (typeof layout.bands)[number];
    // Řada bez mezery: auto pruhu každých deset tiků.
    const first = bandLanesOf(layout, band)[0] as HopLane;
    const jam = Array.from({ length: Math.ceil(first.period / 10) }, (_, index) => ({ ...first, phase: (first.phase + 10 * index) % first.period }));
    const blocked: HopLayout = { ...layout, lanes: [...layout.lanes, ...jam] };
    expect(bandWait(bandLanesOf(blocked, band))).toBeGreaterThan(HOP.longestWait);
    expect(checkHopLevel(hopLevel(blocked), blocked, params).join(' ')).toMatch(/can keep the bot waiting/);
    const late: HopLayout = { ...layout, lanes: layout.lanes.map((lane, index) => (index === 0 ? { ...lane, warm: 40 } : lane)) };
    expect(checkHopLevel(hopLevel(late), late, params).join(' ')).toMatch(/pre-rolled too late/);
    const road: HopLayout = { ...layout, kinds: layout.kinds.map((kind, index) => (index === 1 ? ROW.road : kind)) };
    expect(checkHopLevel(hopLevel(road), road, params).join(' ')).toMatch(/row 1 is not grass/);
  });

  it('the guaranteed crossing of every band is clear in the middle column', () => {
    for (const seed of [1, 2, 3]) {
      const layout = hopLayout(seed, DEFAULTS);
      for (const band of layout.bands) expect(bandWait(bandLanesOf(layout, band)), `seed ${seed} band ${band.first}`).toBeLessThanOrEqual(HOP.longestWait);
    }
    // Kontrola obsazení: auto pruhu, které právě stojí uprostřed, sloupec zabírá.
    const lane = car(2, 100);
    expect(laneClear(lane, 0, 100)).toBe(false);
    expect(laneClear(lane, 0, 140)).toBe(true);
  });
});

describe('hop bot', () => {
  it('waits on the grass for a car to pass and then crosses without being hit', () => {
    // Auto zabírá prostřední sloupec silnice v krocích 8–22: skok hned na startu by do něj vletěl.
    const world = handWorld([ROW.grass, ROW.road, ROW.grass], [car(1, 15)]);
    const run = runBot(world);
    expect(run.outcome).toBe('won');
    expect(playRecord(world, run.inputs).lifeTicks).toEqual([]);
    const first = run.inputs.find((input) => (input.buttons & BUTTON.TAP) !== 0);
    expect(first?.tick).toBeGreaterThan(12);
  });

  it('with a slow reaction it misses a car that has just come in (the reaction reserve); the world bot sees it', () => {
    // Rychlé auto vyjede v tiku 100 a prostředním sloupcem projede po kroku 127. V tiku 112 ho robot světa (stav starý
    // 8 tiků) vidí a čeká; kdo vidí stav starý 20 tiků, ho ještě nezaregistroval a skočí do silnice.
    const kinds = [ROW.grass, ROW.grass, ROW.road, ROW.grass];
    const world = handWorld(kinds, [car(2, 127, 250)]);
    const now = 112;
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const history: Int32Array[] = [];
    // Hrdina doskáče na řadu 1 (trávu před silnicí) a čeká.
    for (let tick = 0; tick <= now; tick += 1) {
      history[tick] = state.slice();
      step(state, tick === 0 ? TAP : NO_INPUT, program);
    }
    // Každé pozorování svými parametry: robot si plán pamatuje podle nich.
    const decide = (age: number) => planHop({ state: history[now - age] as Int32Array, player: 0, tick: now - age, recent: Array.from({ length: age }, () => NO_INPUT) }, hopBot.params.parse(world.bot.params) as HopBotParams);
    expect(decide(8).input.buttons & BUTTON.TAP).toBe(0);
    expect(decide(20).input.buttons & BUTTON.TAP).toBe(BUTTON.TAP);
  });

  it('the threat probe hops straight into a car it can see', () => {
    // Auto vyjede v tiku 0 a prostředním sloupcem projede po kroku 45: skok v tiku 30 do něj vletí.
    const world = handWorld([ROW.grass, ROW.road, ROW.grass], [car(1, 45)]);
    const params = hopBot.params.parse(world.bot.params) as HopBotParams;
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    for (let tick = 0; tick < 30; tick += 1) step(state, NO_INPUT, program);
    const observation = { state, player: 0, tick: 30, recent: [] };
    expect(hopProbeInput(observation, params, NO_INPUT).buttons & BUTTON.TAP).toBe(BUTTON.TAP);
    expect(hopProbeInput({ ...observation, state: instantiate(world), tick: 0 }, params, NO_INPUT)).toEqual(NO_INPUT);
  });

  it('the bot piece is registered and reacts like the course check assumes', () => {
    expect(ARCADE_LIBRARY.bots.hop_bot).toBe(hopBot);
    expect(hopBot.reactionTicks).toBe(8);
  });
});

describe('hop gates on the live cell (G1, G2, G4, G5, G6)', () => {
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

  it('G2 + G6: an idle player crosses no row and the eagle takes him at six seconds; the bot crosses every row', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const idle = playRecord(world, []);
      expect(outcomeOf(idle.state), `seed ${seed}`).toBe('lost');
      // Prohru dal orel, ne náraz: tik orla a všechny životy.
      expect(idle.state[HEADER.tick], `seed ${seed}`).toBe(HOP.eagle);
      expect(idle.lifeTicks, `seed ${seed}`).toEqual([]);
      expect(items(idle.state), `seed ${seed}`).toBe(0);
      const bot = playRecord(world, botRun(seed).inputs);
      expect(items(bot.state), `seed ${seed}`).toBe(DEFAULTS.rows);
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

  it('G5: lives, the row combo and the end bonus are in the live world', () => {
    const world = worldOf(3);
    expect(world.initial[HEADER.counters + COUNTER.health]).toBe(HOP.lives);
    expect(world.rules.find((ref) => ref.id === 'hop_cross')?.params.combo).toBeTypeOf('number');
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
  });

  it('witnesses hop and reach in the bot run, and the car harms in its probe', () => {
    if (spec === null) throw new Error('hop.default is not a live cell');
    const made = arcadeWorldOf(spec, 2);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    const verbs = new Set(verdict.witnesses.map((witness) => witness.verb));
    for (const verb of ['hop', 'reach', 'obstacle']) expect(verbs.has(verb), verb).toBe(true);
    expect(verdict.failures).toEqual([]);
  });
});

describe('hop difficulty band (G3 on 20 seeds; the gate itself is difficulty.test.ts)', () => {
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
