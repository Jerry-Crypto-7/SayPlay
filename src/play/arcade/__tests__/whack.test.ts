/**
 * Bouchání (P54C T6): z pěti děr vykukují cíle, hrdina do nich bouchá. Hlídá společné brány žánru
 * G1 (robot vyhraje 20/20 za 30–90 s), G2 (nečinný nevyhraje), G6 (čítač rozbitých se pohne jen
 * robotovi), G4/G5 a pásmo G3 na 20 semínkách, plus pravidla, která bez dozoru rozhodují o životech:
 * hodný cíl bere život, schovaný krtek až nad kvótu, ťuk do prázdné díry shodí kombo a kdo mačká
 * všechny díry, prohraje.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, type ArcadeLevel, type ArcadeWorld, BODY, BUTTON, type BodyInit, COUNTER, HEADER, type InputEvent, NO_INPUT, START_LIVES, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import { LANES, LANE_START, axisOfLane, laneX } from '../pieces/lanes';
import { EVENT_MARK, LANE_EVENTS } from '../pieces/lane-events';
import { ESCAPED, type Pop, WHACK, checkWhackLevel, startY, whackInView, whackLevel, whackParams, whackPlainPops, whackPops, windowOf } from '../pieces/whack';
import { whackBot } from '../pieces/whack-bot';
import { funMetrics, traceRun } from '../telemetry';
import { BOT_PROFILES, type BotProfile, runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '../../compose/allowed';
import { compileRecipe } from '../../compose/compile';
import { DIRECTOR_PENDING, GENRE_ANSWER_SCHEMA } from '../../director/answer-schema';
import { COUNT_PARAMS } from '../../genre/contract';
import { classifyGenre } from '../../genre/classify';
import { whackGenre } from '../../genre/whack';
import { compileGenre, readGenreSpec } from '../../genre/index';
import { readGameSpec } from '../../spec';

const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);
const DEFAULTS = whackParams.parse({});
/** Okno kratší, než robot stihne (reakce 8 + rezerva). */
const WHACK_REACTION_TOO_SHORT = 10;

const cell = liveCells().find((candidate) => candidate.id === 'whack.default');
const spec = cell === undefined ? null : compileRecipe(assemblyOfCell(cell));

function worldOf(seed: number): ArcadeWorld {
  if (spec === null) throw new Error('whack.default is not a live cell');
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Konec přehrání záznamu jako `replay`, ale se stavem – čítače a životy. */
function finalState(world: ArcadeWorld, inputs: readonly InputEvent[]): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let next = 0;
  for (let tick = 0; tick < 5400 && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  return state;
}

const items = (state: Int32Array): number => state[HEADER.counters + COUNTER.items] as number;
const health = (state: Int32Array): number => state[HEADER.counters + COUNTER.health] as number;
const score = (state: Int32Array): number => state[HEADER.counters + COUNTER.score] as number;

/** Cíl, který v díře `hole` vykoukne v kroku `up` a je otevřený `window` tiků (jako generátor). */
function pop(role: 'target' | 'hazard', hole: number, up: number, window = 30): BodyInit {
  const vy = Math.ceil(WHACK.band / window);
  return { role, kind: role === 'hazard' ? 'snag' : 'target', x: laneX(hole), y: startY(up, vy), z: WHACK.holeZ, ...WHACK.target, solid: false, vy, kinematic: true };
}

/** Malý svět bouchání z ručně položených cílů, s kombem jako živá hra; hrdina stojí ve startovním pruhu. */
function handWorld(targets: readonly BodyInit[], lives = START_LIVES, need = 50): ArcadeWorld {
  const hero: BodyInit = { role: 'player', kind: 'player', x: laneX(LANE_START), y: 0, z: 0, ...WHACK.hero, solid: false };
  const keeper = 1 + targets.length;
  const level: ArcadeLevel = { bodies: [hero, ...targets, { role: 'thing', kind: 'player', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true }], length: 0 };
  const built = buildWorld({
    seed: 1,
    control: { id: 'lanes', params: {} },
    rules: [
      { id: 'whack_hit', params: { free: WHACK.free, points: WHACK.points, combo: keeper } },
      { id: 'catch_goal', params: { need } },
      { id: 'out_of_health', params: {} },
    ],
    bot: { id: 'whack_bot', params: {} },
    level,
    health: lives,
  }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Stav po `ticks` tikech se vstupy podle tiku. */
function playFor(world: ArcadeWorld, ticks: number, input: (tick: number) => InputEvent | null = () => null): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < ticks; tick += 1) step(state, input(tick) ?? NO_INPUT, program);
  return state;
}

/** Ťuk do díry `hole` v tiku `at`. */
const tapAt = (at: number, hole: number) => (tick: number): InputEvent | null => (tick === at ? { tick, buttons: BUTTON.TAP, axis: axisOfLane(hole) } : null);

describe('whack genre is live (P54C T6)', () => {
  it('has a live whack.default cell, a ready module and the whack generator', () => {
    expect(cell?.status).toBe('live');
    expect(whackGenre.availability('default')).toBe('ready');
    expect(MODE_GENERATORS.whack_holes?.id).toBe('whack_holes');
    expect(spec?.control).toBe('lanes');
    expect(readGameSpec(spec).ok).toBe(true);
    expect(spec?.roles.find((role) => role.id === 'target')?.label).toBe('mole');
    expect(spec?.roles.find((role) => role.id === 'hazard')?.label).toBe('bunny');
  });

  it('reads the struck and the spared thing from the sentence: whack, hit, pop, smash, squash', () => {
    const fill = whackGenre.draftFill('a farmer whacks the moles but not the bunnies', null);
    expect(fill.cast).toContainEqual({ label: 'mole', does: 'shoot_at' });
    expect(fill.cast).toContainEqual({ label: 'bunny', does: 'avoid' });
    for (const [sentence, label] of [['pop the balloons at the fair', 'balloon'], ['a cat smashes bugs in the kitchen', 'bug'], ['squash the slimes', 'slime'], ['hit the zombies, spare the kittens', 'zombie']] as const) {
      expect(whackGenre.draftFill(sentence, null).cast?.[0], sentence).toEqual({ label, does: 'shoot_at' });
    }
    expect(whackGenre.draftFill('hit the zombies, spare the kittens', null).cast).toContainEqual({ label: 'kitten', does: 'avoid' });
    // Honič věty je v bouchání cíl: jinou roli nepřítele žánr nemá.
    const chased = whackGenre.draftFill('a dog bonks gophers while a wolf chases it', null);
    expect(chased.cast?.every((item) => item.does === 'shoot_at' || item.does === 'avoid')).toBe(true);
    const read = readGenreSpec({ genre: 'whack', mode: 'default', hero: 'fox', setting: 'garden', cast: [{ label: 'rat', does: 'shoot_at' }, { label: 'kitten', does: 'avoid' }], counts: { enemy: 24 } });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const game = compileGenre(read.value);
    expect(game.roles.find((role) => role.id === 'target')?.label).toBe('rat');
    expect(game.roles.find((role) => role.id === 'hazard')?.label).toBe('kitten');
    expect((game.controlParams as { tuning: { targets: number } }).tuning.targets).toBe(24);
    expect(COUNT_PARAMS.whack.default?.enemy).toBe('targets');
    expect(game.tutorial.goalLine.length).toBeLessThanOrEqual(50);
    // Počet z věty nad mezí se ořízne (P54C): žánr zůstane.
    const over = readGenreSpec({ genre: 'whack', mode: 'default', hero: 'fox', setting: 'garden', counts: { enemy: WHACK.targets.max + 1 } });
    expect(over.ok && over.value.counts?.enemy).toBe(WHACK.targets.max);
  });

  // P54C T13: klasifikátor bouchání zná; samotné „pop the balloons“ (věta j05 P30) zůstává úkolem po scéně.
  it('is offered to sentences about things popping up (T13) and by the director (T14)', () => {
    for (const sentence of ['whack the moles before they hide', 'a farmer smashes the moles in his garden']) {
      expect(classifyGenre(sentence, null).ranked[0]?.genre, sentence).toBe('whack');
    }
    expect(classifyGenre('pop the balloons at the fair', null).ranked[0]?.genre).not.toBe('whack');
    expect(DIRECTOR_PENDING.has('whack')).toBe(false);
    expect(JSON.stringify(GENRE_ANSWER_SCHEMA)).toContain('"whack"');
  });
});

describe('whack level is playable by construction', () => {
  it('passes its own check on 20 seeds for small, default and large goals and any lives', () => {
    for (const seed of SEEDS) for (const goal of [WHACK.targets.min, DEFAULTS.targets, WHACK.targets.max]) for (const lives of [1, START_LIVES, 9]) {
      const params = whackParams.parse({ targets: goal });
      expect(checkWhackLevel(whackLevel(seed, params, lives), params, lives), `seed ${seed}, ${goal} targets, ${lives} lives`).toEqual([]);
    }
  });

  it('fails its check when a mole hides too soon, shares a hole, or a good target pops alone', () => {
    const level = whackLevel(1, DEFAULTS, START_LIVES);
    const pops = whackPops(1, DEFAULTS, START_LIVES);
    const swapped = (index: number, body: BodyInit): ArcadeLevel => ({ ...level, bodies: level.bodies.map((old, at) => (at === index + 1 ? body : old)) });
    const first = pops[0]!;
    expect(checkWhackLevel(swapped(0, pop('target', first.hole, first.up, WHACK_REACTION_TOO_SHORT)), DEFAULTS, START_LIVES).join(' ')).toMatch(/too soon/);
    const second = pops.findIndex((entry, index) => index > 0 && !entry.good);
    expect(checkWhackLevel(swapped(second, pop('target', first.hole, first.up + 1)), DEFAULTS, START_LIVES).join(' ')).toMatch(/before the target/);
    const good = pops.findIndex((entry) => entry.good);
    expect(checkWhackLevel(swapped(good, pop('hazard', pops[good]!.hole, pops[good]!.up + 7)), DEFAULTS, START_LIVES).join(' ')).toMatch(/no mole/);
  });

  it('opens a hole on the tick computed from the seed and keeps it open for the window', () => {
    const world = handWorld([pop('target', 0, 30, 20)]);
    const y = (state: Int32Array) => state[bodyBase(1) + BODY.y] as number;
    expect(y(playFor(world, 30))).toBeLessThan(0);
    expect(y(playFor(world, 31))).toBe(0);
    expect(y(playFor(world, 50))).toBeLessThan(WHACK.band);
    expect(windowOf(Math.ceil(WHACK.band / 20))).toBe(20);
    // Okno doběhlo: v kroku up + okno se krtek schová a zmizí.
    expect(playFor(world, 51)[bodyBase(1) + BODY.flags]! & 1).toBe(0);
  });
});

describe('whack rules', () => {
  it('a tap in the window scores and counts; a tap before the mole pops or after it hides does not', () => {
    const world = handWorld([pop('target', 0, 30, 20)]);
    const hit = playFor(world, 60, tapAt(40, 0));
    expect(items(hit)).toBe(1);
    expect(score(hit)).toBe(WHACK.points);
    expect(items(playFor(world, 60, tapAt(29, 0)))).toBe(0);
    expect(items(playFor(world, 60, tapAt(50, 0)))).toBe(0);
    expect(items(playFor(world, 60, tapAt(40, 1)))).toBe(0);
  });

  it('whacking the good target takes a life, sparing it does not', () => {
    const world = handWorld([pop('target', 0, 30), pop('hazard', 4, 30)]);
    expect(health(playFor(world, 40, tapAt(35, 4)))).toBe(START_LIVES - 1);
    expect(health(playFor(world, 40, tapAt(35, 0)))).toBe(START_LIVES);
    // Tři hodné cíle = konec hry.
    const three = handWorld([pop('hazard', 1, 20), pop('hazard', 3, 60), pop('hazard', 4, 100)]);
    const taps = (tick: number): InputEvent | null => (tick === 25 ? { tick, buttons: BUTTON.TAP, axis: axisOfLane(1) } : tick === 65 ? { tick, buttons: BUTTON.TAP, axis: axisOfLane(3) } : tick === 105 ? { tick, buttons: BUTTON.TAP, axis: axisOfLane(4) } : null);
    expect(outcomeOf(playFor(three, 140, taps))).toBe('lost');
  });

  it('an escaped mole is free up to the quota, then each costs a life', () => {
    const window = 20;
    const world = handWorld(Array.from({ length: WHACK.free + 2 }, (_, index) => pop('target', index % LANES.count, 20 + 40 * index, window)));
    const hidden = (index: number): number => 20 + 40 * index + window + 1;
    expect(health(playFor(world, hidden(WHACK.free - 1)))).toBe(START_LIVES);
    const after = playFor(world, hidden(WHACK.free));
    expect(health(after)).toBe(START_LIVES - 1);
    expect((after[bodyBase(1) + BODY.flags]! >> 10) & 3).toBe(ESCAPED);
    expect(health(playFor(world, hidden(WHACK.free + 1)))).toBe(START_LIVES - 2);
  });

  it('a tap into an empty hole breaks the combo: the next hit scores ×1', () => {
    const moles = [pop('target', 0, 20), pop('target', 1, 60), pop('target', 2, 100)];
    const inRow = (tick: number): InputEvent | null => (tick === 25 ? { tick, buttons: BUTTON.TAP, axis: axisOfLane(0) } : tick === 65 ? { tick, buttons: BUTTON.TAP, axis: axisOfLane(1) } : tick === 105 ? { tick, buttons: BUTTON.TAP, axis: axisOfLane(2) } : null);
    const clean = playFor(handWorld(moles), 140, inRow);
    expect(score(clean)).toBe(WHACK.points * (1 + 2 + 3));
    const missed = playFor(handWorld(moles), 140, (tick) => inRow(tick) ?? (tick === 80 ? { tick, buttons: BUTTON.TAP, axis: axisOfLane(4) } : null));
    expect(score(missed)).toBe(WHACK.points * (1 + 2 + 1));
    expect(items(missed)).toBe(3);
  });

  it('wins on the goal count', () => {
    const world = handWorld([pop('target', 0, 20), pop('target', 1, 60), pop('target', 2, 100)], START_LIVES, 2);
    const state = playFor(world, 140, (tick) => (tick === 25 ? { tick, buttons: BUTTON.TAP, axis: axisOfLane(0) } : tick === 65 ? { tick, buttons: BUTTON.TAP, axis: axisOfLane(1) } : null));
    expect(outcomeOf(state)).toBe('won');
  });
});

describe('whack gates on the live cell (G1, G2, G4, G5, G6)', () => {
  it('G1: the world bot wins on all 20 seeds in 30–90 s', () => {
    for (const seed of SEEDS) {
      const run = runBot(worldOf(seed));
      expect(run.outcome, `seed ${seed}`).toBe('won');
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeGreaterThanOrEqual(30);
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeLessThanOrEqual(90);
    }
  });

  it('G2 + G6: an idle player never wins and never whacks; the bot whacks the goal and spares every good target', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const idle = finalState(world, []);
      expect(outcomeOf(idle), `seed ${seed}`).toBe('lost');
      expect(items(idle), `seed ${seed}: idle whacked`).toBe(0);
      const bot = finalState(world, runBot(world).inputs);
      expect(items(bot), `seed ${seed}: bot whacked`).toBe(DEFAULTS.targets);
      expect(health(bot), `seed ${seed}: bot hit a good target or let moles go`).toBe(START_LIVES);
    }
  });

  it('a player who mashes every hole hits the good targets and loses', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const mash = Array.from({ length: 5400 }, (_, tick): InputEvent => ({ tick, buttons: BUTTON.TAP, axis: axisOfLane(tick % LANES.count) }));
      expect(outcomeOf(finalState(world, mash)), `seed ${seed}`).toBe('lost');
    }
  });

  it('G4: the same seed builds the same world and the bot record replays to its hash', () => {
    for (const seed of [1, 7, 20]) {
      expect(canonicalHash(worldOf(seed))).toBe(canonicalHash(worldOf(seed)));
      const world = worldOf(seed);
      const run = runBot(world);
      expect(replay(world, run.inputs, ARCADE_LIBRARY).hash).toBe(run.hash);
    }
    expect(canonicalHash(worldOf(1))).not.toBe(canonicalHash(worldOf(2)));
  });

  it('G5: lives, combo and the end bonus are in the live world', () => {
    const world = worldOf(3);
    expect(world.initial[HEADER.counters + COUNTER.health]).toBe(START_LIVES);
    const hit = world.rules.find((ref) => ref.id === 'whack_hit');
    expect(hit?.params.combo).toBeTypeOf('number');
    expect(world.rules.some((ref) => ref.id === 'score_bonus')).toBe(true);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const inputs = runBot(world).inputs;
    let best = 1;
    let next = 0;
    for (let tick = 0; outcomeOf(state) === 'running' && tick < 5400; tick += 1) {
      while (next < inputs.length && inputs[next]!.tick < tick) next += 1;
      const effects = step(state, inputs[next]?.tick === tick ? inputs[next]! : NO_INPUT, program);
      for (const effect of effects) if (effect.kind === 'combo') best = Math.max(best, effect.multiplier);
    }
    expect(best).toBeGreaterThanOrEqual(3);
  });

  it('witnesses whack, defeat and the lanes move in the bot run, and the good target harms in its probe', () => {
    if (spec === null) throw new Error('whack.default is not a live cell');
    const made = arcadeWorldOf(spec, 2);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    const verbs = new Set(verdict.witnesses.map((witness) => witness.verb));
    for (const verb of ['whack', 'defeat', 'lanes', 'hazard']) expect(verbs.has(verb), verb).toBe(true);
    expect(verdict.failures).toEqual([]);
  });
});

describe('whack difficulty band (G3 on 20 seeds; the gate itself is difficulty.test.ts)', () => {
  const rate = (profile: BotProfile): number => SEEDS.filter((seed) => runBot(worldOf(seed), undefined, { profile }).outcome === 'won').length / SEEDS.length;
  it('novice wins 0.3–0.7, intermediate at least 0.8', () => {
    expect(Object.keys(BOT_PROFILES)).toEqual(['novice', 'intermediate']);
    const novice = rate('novice');
    const intermediate = rate('intermediate');
    expect(novice, `novice ${novice}`).toBeGreaterThanOrEqual(0.3);
    expect(novice, `novice ${novice}`).toBeLessThanOrEqual(0.7);
    expect(intermediate, `intermediate ${intermediate}`).toBeGreaterThanOrEqual(0.8);
  });

  it('the bot piece is registered and reacts like the generator assumes', () => {
    expect(ARCADE_LIBRARY.bots.whack_bot).toBe(whackBot);
    expect(whackBot.reactionTicks).toBe(8);
  });
});

describe('whack lane events (P55 T5)', () => {
  const bonus = (mark: number, hole: number, up: number, window = 30): BodyInit => ({ ...pop('target', hole, up, window), hp: mark });

  it('a whacked bonus scores without counting toward the goal; a hidden one costs nothing', () => {
    const golden = handWorld([bonus(EVENT_MARK.golden, 0, 30, 20)]);
    const hit = playFor(golden, 60, tapAt(40, 0));
    expect(items(hit)).toBe(0);
    expect(score(hit)).toBe(WHACK.points * LANE_EVENTS.goldenPoints);
    expect(whackInView(playFor(golden, 35), 1)).toBe(true);
    expect(whackInView(playFor(golden, 30), 1)).toBe(false);
    // Víc schovaných bonusů, než je volných krtků: žádný život.
    const bonuses = Array.from({ length: WHACK.free + 2 }, (_, index) => bonus(EVENT_MARK.series, index % LANES.count, 20 + 40 * index, 20));
    expect(health(playFor(handWorld(bonuses), 40 + 40 * (WHACK.free + 2)))).toBe(START_LIVES);
  });

  it('moles and good targets pop exactly as without events; a rush and a bonus within 10 s on every seed', () => {
    const seen = new Set<number>();
    for (const seed of SEEDS) {
      const pops = whackPops(seed, DEFAULTS, START_LIVES);
      expect(pops.filter((entry) => entry.mark === 0), `seed ${seed}`).toEqual(whackPlainPops(seed, DEFAULTS, START_LIVES));
      const bonuses = pops.filter((entry) => entry.mark > 0).sort((a, b) => a.up - b.up);
      for (const entry of bonuses) seen.add(entry.mark);
      expect(bonuses.some((entry) => entry.mark === EVENT_MARK.rush), `seed ${seed}`).toBe(true);
      expect(bonuses[0]!.up, `seed ${seed}`).toBeLessThanOrEqual(600);
    }
    expect(seen).toEqual(new Set(Object.values(EVENT_MARK)));
  });

  it('the middle third has more targets out at once than without events', () => {
    const third = (pops: readonly Pop[]): number => {
      const moles = pops.filter((entry) => !entry.good && entry.mark === 0);
      const [from, to] = [moles[Math.floor(DEFAULTS.targets / 3)]!.up, moles[Math.floor((2 * DEFAULTS.targets) / 3)]!.up];
      let most = 0;
      for (let tick = from; tick < to; tick += 1) most = Math.max(most, pops.filter((entry) => entry.up <= tick && tick < entry.up + entry.window).length);
      return most;
    };
    const richer = SEEDS.filter((seed) => third(whackPops(seed, DEFAULTS, START_LIVES)) > third(whackPlainPops(seed, DEFAULTS, START_LIVES)));
    expect(richer.length).toBeGreaterThanOrEqual(15);
  });

  it('seed 1: lively from start to finish and still a 30–90 s win (baseline 1.18 events/s)', () => {
    const world = worldOf(1);
    const bot = runBot(world, undefined, { profile: 'intermediate' });
    const trace = traceRun(world, bot.inputs);
    const fun = funMetrics(trace);
    expect(fun.eventsPerS).toBeGreaterThanOrEqual(1.77);
    expect(fun.longestGapS).toBeLessThanOrEqual(3);
    const own = runBot(world);
    expect(own.outcome).toBe('won');
    expect(own.tick / ARCADE_HZ).toBeGreaterThanOrEqual(30);
    expect(own.tick / ARCADE_HZ).toBeLessThanOrEqual(90);
    expect(traceRun(worldOf(1), bot.inputs).hash).toBe(trace.hash);
  });
});
