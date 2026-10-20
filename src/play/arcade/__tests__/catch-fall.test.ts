/**
 * Chytání (P54C T5): věci padají v pěti pruzích, hrdina je chytá. Hlídá společné brány žánru
 * G1 (robot vyhraje 20/20 za 30–90 s), G2 (nečinný nevyhraje), G6 (čítač chycených se pohne jen
 * robotovi) a pásmo G3 na 20 semínkách, plus pravidla, která bez dozoru rozhodují o životech:
 * bomba v koši bere život, propadlé ovoce až nad kvótou, dopad je jeden spočitatelný tik.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, type ArcadeLevel, type ArcadeWorld, type BodyInit, COUNTER, HEADER, type InputEvent, NO_INPUT, START_LIVES, bodyBase, BODY } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import { CATCH, catchDrops, catchLevel, catchParams, checkCatchLevel, landingTick, travelTicks } from '../pieces/catch-fall';
import { catchBot } from '../pieces/catch-fall-bot';
import { LANES, LANE_START, axisOfLane, laneX } from '../pieces/lanes';
import { BOT_PROFILES, type BotProfile, runBot } from '../verify';
import { assemblyOfCell, liveCells } from '../../compose/allowed';
import { compileRecipe } from '../../compose/compile';
import { COUNT_PARAMS } from '../../genre/contract';
import { classifyGenre } from '../../genre/classify';
import { catchGenre } from '../../genre/catch';
import { compileGenre, readGenreSpec } from '../../genre/index';
import { readGameSpec } from '../../spec';

const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);
const DEFAULTS = catchParams.parse({});

const cell = liveCells().find((candidate) => candidate.id === 'catch.default');
const spec = cell === undefined ? null : compileRecipe(assemblyOfCell(cell));

function worldOf(seed: number): ArcadeWorld {
  if (spec === null) throw new Error('catch.default is not a live cell');
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

/** Věc, která protne lapací čáru v tiku `landing` v pruhu `lane` (jako generátor). */
function thing(role: 'collectible' | 'hazard', lane: number, landing: number, speed = CATCH.speeds[0] as number): BodyInit {
  return { role, kind: role === 'hazard' ? 'snag' : 'coin', x: laneX(lane), y: CATCH.catchY + speed * (landing + 1), z: 0, ...CATCH.thing, solid: false, vy: -speed, kinematic: true };
}

/** Malý svět chytání z ručně položených věcí; hrdina stojí ve startovním pruhu. */
function handWorld(things: readonly BodyInit[], lives = START_LIVES, need = 50): ArcadeWorld {
  const level: ArcadeLevel = { bodies: [{ role: 'player', kind: 'player', x: laneX(LANE_START), y: 0, z: 0, ...CATCH.hero, solid: false }, ...things], length: 0 };
  const built = buildWorld({
    seed: 1,
    control: { id: 'lanes', params: {} },
    rules: [
      { id: 'catch_fall', params: { free: CATCH.free, points: CATCH.points } },
      { id: 'catch_goal', params: { need } },
      { id: 'out_of_health', params: {} },
    ],
    bot: { id: 'catch_bot', params: {} },
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

describe('catch genre is live (P54C T5)', () => {
  it('has a live catch.default cell, a ready module and the catch generator', () => {
    expect(cell?.status).toBe('live');
    expect(catchGenre.availability('default')).toBe('ready');
    expect(MODE_GENERATORS.catch_fall?.id).toBe('catch_fall');
    expect(spec?.control).toBe('lanes');
    expect(readGameSpec(spec).ok).toBe(true);
  });

  it('reads collect and avoid from the cast: the caught thing and the falling bomb', () => {
    const fill = catchGenre.draftFill('a fox catches apples and dodges rocks', null);
    expect(fill.cast).toContainEqual({ label: 'apple', does: 'collect' });
    expect(fill.cast?.some((item) => item.does === 'avoid')).toBe(true);
    // Honič věty padá jako bomba: chytání jinou roli nepřítele nemá.
    const chased = catchGenre.draftFill('a hamster catches seeds while a cat chases it', null);
    expect(chased.cast?.every((item) => item.does === 'collect' || item.does === 'avoid')).toBe(true);
    const read = readGenreSpec({ genre: 'catch', mode: 'default', hero: 'fox', setting: 'orchard', cast: [{ label: 'pear', does: 'collect' }, { label: 'rotten egg', does: 'avoid' }], counts: { collectible: 24 } });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const game = compileGenre(read.value);
    expect(game.roles.find((role) => role.id === 'coin')?.label).toBe('pear');
    expect(game.roles.find((role) => role.id === 'hazard')?.label).toBe('rotten egg');
    expect((game.controlParams as { tuning: { items: number } }).tuning.items).toBe(24);
    expect(COUNT_PARAMS.catch.default?.collectible).toBe('items');
    expect(game.tutorial.goalLine.length).toBeLessThanOrEqual(50);
  });

  // P54C T13: klasifikátor chytání zná – jen co padá, honička („catch the thief“) zůstává honičkou.
  it('is offered to sentences about falling things (T13), never to a chase', () => {
    expect(classifyGenre('a fox catches falling apples', null).ranked[0]?.genre).toBe('catch');
    for (const sentence of ['the police try to catch the thief', 'a squirrel hoards acorns before winter comes']) {
      expect(classifyGenre(sentence, null).ranked[0]?.genre, sentence).not.toBe('catch');
    }
  });
});

describe('catch level is playable by construction', () => {
  it('passes its own check on 20 seeds for small, default and large goals and any lives', () => {
    for (const seed of SEEDS) for (const goal of [CATCH.items.min, DEFAULTS.items, CATCH.items.max]) for (const lives of [1, START_LIVES, 9]) {
      const params = catchParams.parse({ items: goal });
      expect(checkCatchLevel(catchLevel(seed, params, lives), params, lives), `seed ${seed}, ${goal} items, ${lives} lives`).toEqual([]);
    }
  });

  it('fails its check when fruit lands too soon or in the start lane early', () => {
    const level = catchLevel(1, DEFAULTS, START_LIVES);
    const drops = catchDrops(1, DEFAULTS, START_LIVES);
    const first = drops[0]!;
    // Těla úrovně jsou hrdina a pak dopady v pořadí `catchDrops`.
    const second = drops.findIndex((drop, index) => index > 0 && !drop.bomb);
    const swapped = (body: BodyInit): ArcadeLevel => ({ ...level, bodies: level.bodies.map((old, index) => (index === second + 1 ? body : old)) });
    // Druhé ovoce o tik po prvním, přes celou šíři: robot ho nestihne.
    expect(checkCatchLevel(swapped(thing('collectible', first.lane === 0 ? 4 : 0, first.landing + 1)), DEFAULTS, START_LIVES).join(' ')).toMatch(/too soon/);
    expect(checkCatchLevel(swapped(thing('collectible', LANE_START, drops[second]!.landing, drops[second]!.speed)), DEFAULTS, START_LIVES).join(' ')).toMatch(/start lane/);
  });

  it('crosses the catch line on the landing tick computed from the seed', () => {
    const world = handWorld([thing('collectible', 0, 30)]);
    const before = playFor(world, 30);
    const after = playFor(world, 31);
    const y = (state: Int32Array) => state[bodyBase(1) + BODY.y] as number;
    expect(y(before)).toBeGreaterThan(CATCH.catchY);
    expect(y(after)).toBeLessThanOrEqual(CATCH.catchY);
    expect(landingTick(thing('collectible', 0, 30).y, CATCH.speeds[0] as number, 0)).toBe(30);
    expect(travelTicks(1)).toBe(3);
    expect(travelTicks(LANES.count - 1)).toBe(18);
  });
});

describe('catch rules', () => {
  it('a caught fruit scores and counts; standing elsewhere it falls through', () => {
    const world = handWorld([thing('collectible', LANE_START, 20)]);
    const caught = playFor(world, 40);
    expect(items(caught)).toBe(1);
    expect(caught[HEADER.counters + COUNTER.score]).toBe(CATCH.points);
    const away = playFor(world, 40, (tick) => ({ tick, buttons: 0, axis: axisOfLane(0) }));
    expect(items(away)).toBe(0);
    expect(health(away)).toBe(START_LIVES);
  });

  it('a bomb in the lane takes a life, a bomb beside the hero does not', () => {
    const world = handWorld([thing('hazard', LANE_START, 20), thing('hazard', LANE_START + 1, 40)]);
    const hit = playFor(world, 60);
    expect(health(hit)).toBe(START_LIVES - 1);
    const dodged = playFor(world, 60, (tick) => (tick < 25 ? { tick, buttons: 0, axis: axisOfLane(0) } : null));
    expect(health(dodged)).toBe(START_LIVES);
    // Tři bomby v koši = konec hry.
    const three = handWorld([thing('hazard', LANE_START, 20), thing('hazard', LANE_START, 40), thing('hazard', LANE_START, 60)]);
    expect(outcomeOf(playFor(three, 80))).toBe('lost');
  });

  it('missed fruit is free up to the quota, then each costs a life', () => {
    const world = handWorld(Array.from({ length: CATCH.free + 2 }, (_, index) => thing('collectible', 0, 20 + 20 * index)));
    expect(health(playFor(world, 20 + 20 * (CATCH.free - 1) + 1))).toBe(START_LIVES);
    expect(health(playFor(world, 20 + 20 * CATCH.free + 1))).toBe(START_LIVES - 1);
    expect(health(playFor(world, 20 + 20 * (CATCH.free + 1) + 1))).toBe(START_LIVES - 2);
  });

  it('wins on the goal count and despawns what hits the ground', () => {
    const world = handWorld([thing('collectible', LANE_START, 20), thing('collectible', LANE_START, 40), thing('collectible', 0, 60)], START_LIVES, 2);
    const state = playFor(world, 45);
    expect(outcomeOf(state)).toBe('won');
    const ground = handWorld([thing('collectible', 0, 20)]);
    const fallen = playFor(ground, 60);
    expect(fallen[bodyBase(1) + BODY.flags]! & 1).toBe(0);
  });
});

describe('catch gates on the live cell (G1, G2, G4, G6)', () => {
  it('G1: the world bot wins on all 20 seeds in 30–90 s', () => {
    for (const seed of SEEDS) {
      const run = runBot(worldOf(seed));
      expect(run.outcome, `seed ${seed}`).toBe('won');
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeGreaterThanOrEqual(30);
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeLessThanOrEqual(90);
    }
  });

  it('G2 + G6: an idle player never wins and never catches; the bot catches the goal', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const idle = finalState(world, []);
      expect(outcomeOf(idle), `seed ${seed}`).toBe('lost');
      expect(items(idle), `seed ${seed}: idle caught`).toBe(0);
      const bot = finalState(world, runBot(world).inputs);
      expect(items(bot), `seed ${seed}: bot caught`).toBe(DEFAULTS.items);
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
    const fall = world.rules.find((ref) => ref.id === 'catch_fall');
    expect(fall?.params.combo).toBeTypeOf('number');
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
});

describe('catch difficulty band (G3 on 20 seeds; the gate itself is difficulty.test.ts)', () => {
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
    expect(ARCADE_LIBRARY.bots.catch_bot).toBe(catchBot);
    expect(catchBot.reactionTicks).toBe(8);
  });
});
