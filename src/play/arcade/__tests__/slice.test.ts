/**
 * Krájení (P54C T8): věci vylétají po obloucích v pěti pruzích, hrdina je švihem rozsekne. Hlídá společné
 * brány žánru G1 (robot vyhraje 20/20 za 30–90 s), G2 (nečinný nevyhraje – prohraje propadlým ovocem),
 * G6 (čítač rozseknutých se pohne jen robotovi), G4/G5 a pásmo G3 na 20 semínkách, plus pravidla, která
 * bez dozoru rozhodují o životech: bomba ve švihu bere život v tom tiku, propadlé ovoce shodí kombo a nad
 * kvótu bere život, víc kusů jedním švihem zvedne kombo a kdo švihá do všech pruhů, prohraje na bombách.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeEffect, type ArcadeLevel, type ArcadeWorld, BODY, BUTTON, COMBO, COUNTER, FLAG, HEADER, type InputEvent, NO_INPUT, ROLE, START_LIVES, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import { LANES, axisOfLane, laneOfX, laneX } from '../pieces/lanes';
import { type Launch, SLICE, SLICE_BODIES, type Throw, checkSliceLevel, cutWindow, heightAfter, landingStep, launchesOf, sliceLevel, sliceParams, sliceThrows } from '../pieces/slice';
import { sliceBot } from '../pieces/slice-bot';
import { BOT_PROFILES, type BotProfile, runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '../../compose/allowed';
import { compileRecipe } from '../../compose/compile';
import { DIRECTOR_PENDING, GENRE_ANSWER_SCHEMA } from '../../director/answer-schema';
import { COUNT_PARAMS } from '../../genre/contract';
import { classifyGenre } from '../../genre/classify';
import { compileGenre, readGenreSpec } from '../../genre/index';
import { sliceGenre } from '../../genre/slice';
import { readGameSpec } from '../../spec';

const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);
const DEFAULTS = sliceParams.parse({});
/** Rychlost výhozu v ručních světech: ve výšce řezu kroky 13–61, na zemi v kroku 74. */
const SPEED = 300;

const cell = liveCells().find((candidate) => candidate.id === 'slice.default');
const spec = cell === undefined ? null : compileRecipe(assemblyOfCell(cell));

function worldOf(seed: number): ArcadeWorld {
  if (spec === null) throw new Error('slice.default is not a live cell');
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const items = (state: Int32Array): number => state[HEADER.counters + COUNTER.items] as number;
const health = (state: Int32Array): number => state[HEADER.counters + COUNTER.health] as number;
const score = (state: Int32Array): number => state[HEADER.counters + COUNTER.score] as number;

/** Tik po tiku jako `replay`, se stavem a se záznamem tiků, ve kterých švih rozsekl bombu a ve kterých ubyl život. */
function playRecord(world: ArcadeWorld, inputs: readonly InputEvent[]): { readonly state: Int32Array; readonly bombTicks: number[]; readonly lifeTicks: number[] } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const bombTicks: number[] = [];
  const lifeTicks: number[] = [];
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    const before = health(state);
    const effects = step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    const bomb = effects.some((effect) => effect.kind === 'despawn' && state[bodyBase(effect.body) + BODY.role] === ROLE.hazard && (state[bodyBase(effect.body) + BODY.y] as number) >= SLICE.cutY && ((state[bodyBase(effect.body) + BODY.flags] as number) & FLAG.grounded) === 0);
    if (bomb) bombTicks.push(tick);
    // Tik za každý ztracený život (dvě propadlá ovoce v témže tiku = dva záznamy).
    for (let lost = health(state); lost < before; lost += 1) lifeTicks.push(tick);
  }
  return { state, bombTicks, lifeTicks };
}

/** Výhoz do ručního světa: tik, pruh (a místo v něm), bomba. */
const thrown = (tick: number, lane: number, bomb = false, offset = 0, speed = SPEED): Launch => [tick, laneX(lane) + offset, speed, bomb ? 1 : 0];

/** Malý svět krájení z ručních výhozů, s kombem jako živá hra; hrdina stojí ve startovním pruhu. */
function handWorld(launches: readonly Launch[], lives = START_LIVES, need = 50): ArcadeWorld {
  const level = sliceLevel();
  const keeper = level.bodies.length;
  const withKeeper: ArcadeLevel = { ...level, bodies: [...level.bodies, { role: 'thing', kind: 'player', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true }] };
  const built = buildWorld(
    {
      seed: 1,
      control: { id: 'lanes', params: {} },
      rules: [
        { id: 'slice_cut', params: { fruit: SLICE_BODIES.fruit, bomb: SLICE_BODIES.bomb, launches: [...launches].sort((a, b) => a[0] - b[0]), free: SLICE.free, points: SLICE.points, combo: keeper } },
        { id: 'catch_goal', params: { need } },
        { id: 'out_of_health', params: {} },
      ],
      bot: { id: 'slice_bot', params: {} },
      level: withKeeper,
      health: lives,
    },
    ARCADE_LIBRARY,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Stav po `ticks` tikech se vstupy podle tiku (stav po kroku `t` = `playFor(world, t + 1)`). */
function playFor(world: ArcadeWorld, ticks: number, input: (tick: number) => InputEvent | null = () => null): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < ticks; tick += 1) step(state, input(tick) ?? NO_INPUT, program);
  return state;
}

/** Švihy do pruhů podle tiku. */
const swings = (plan: Readonly<Record<number, number>>) => (tick: number): InputEvent | null => (plan[tick] === undefined ? null : { tick, buttons: BUTTON.TAP, axis: axisOfLane(plan[tick] as number) });

/** První živá věc za předlohami (index těla), nebo −1. */
function flying(state: Int32Array): number {
  for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) if (((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0) return body;
  return -1;
}

describe('slice genre is live (P54C T8)', () => {
  it('has a live slice.default cell, a ready module and the slice generator', () => {
    expect(cell?.status).toBe('live');
    expect(sliceGenre.availability('default')).toBe('ready');
    expect(MODE_GENERATORS.slice_arcs?.id).toBe('slice_arcs');
    expect(spec?.control).toBe('lanes');
    expect(readGameSpec(spec).ok).toBe(true);
    expect(spec?.roles.find((role) => role.id === 'coin')?.label).toBe('watermelon');
    expect(spec?.roles.find((role) => role.id === 'hazard')?.label).toBe('bomb');
  });

  it('reads the sliced and the avoided thing from the sentence: slice, slash, chop, cut', () => {
    const fill = sliceGenre.draftFill('a ninja slices the flying watermelons but not the bombs', null);
    expect(fill.cast).toContainEqual({ label: 'watermelon', does: 'collect' });
    expect(fill.cast).toContainEqual({ label: 'bomb', does: 'avoid' });
    for (const [sentence, label] of [['slash the pumpkins at the fair', 'pumpkin'], ['a samurai cuts flying oranges', 'orange'], ['chop all the carrots, dodge the rocks', 'carrot']] as const) {
      expect(sliceGenre.draftFill(sentence, null).cast?.[0], sentence).toEqual({ label, does: 'collect' });
    }
    expect(sliceGenre.draftFill('chop all the carrots, dodge the rocks', null).cast).toContainEqual({ label: 'rock', does: 'avoid' });
    // Honič věty je v krájení bomba: jinou roli škůdce žánr nemá.
    const chased = sliceGenre.draftFill('a cat slices fish while a dog chases it', null);
    expect(chased.cast?.every((item) => item.does === 'collect' || item.does === 'avoid')).toBe(true);
    const read = readGenreSpec({ genre: 'slice', mode: 'default', hero: 'fox', setting: 'kitchen', cast: [{ label: 'lemon', does: 'collect' }, { label: 'rock', does: 'avoid' }], counts: { collectible: 12 } });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const game = compileGenre(read.value);
    expect(game.roles.find((role) => role.id === 'coin')?.label).toBe('lemon');
    expect(game.roles.find((role) => role.id === 'hazard')?.label).toBe('rock');
    expect((game.controlParams as { tuning: { items: number } }).tuning.items).toBe(12);
    expect(COUNT_PARAMS.slice.default?.collectible).toBe('items');
    expect(game.tutorial.goalLine.length).toBeLessThanOrEqual(50);
    expect(readGenreSpec({ genre: 'slice', mode: 'default', hero: 'fox', setting: 'kitchen', counts: { collectible: SLICE.items.max + 1 } }).ok).toBe(false);
  });

  it('is not offered to sentences before the classifier learns it (T13), nor by the director before T14', () => {
    for (const sentence of ['slice the flying fruit but not the bombs', 'a ninja slashes watermelons in the dojo', 'cut the oranges as they fly']) {
      expect(classifyGenre(sentence, null).ranked[0]?.genre, sentence).not.toBe('slice');
    }
    expect(DIRECTOR_PENDING.has('slice')).toBe(true);
    expect(JSON.stringify(GENRE_ANSWER_SCHEMA)).not.toContain('"slice"');
  });
});

describe('slice flight is integer ballistics (like ballFlight, no Rapier)', () => {
  it('flies the arc computed from the launch, crosses the cut height on known steps and lands on its step', () => {
    expect(heightAfter(SPEED, 12)).toBeLessThan(SLICE.cutY);
    expect(heightAfter(SPEED, 13)).toBe(3172);
    expect(cutWindow(SPEED)).toEqual([13, 61]);
    expect(landingStep(SPEED)).toBe(74);
    const world = handWorld([thrown(10, 1)]);
    for (const step of [1, 13, 37, 61, 73]) {
      const state = playFor(world, 10 + step + 1);
      const body = flying(state);
      expect(body, `step ${step}`).toBeGreaterThanOrEqual(0);
      expect(state[bodyBase(body) + BODY.y], `step ${step}`).toBe(heightAfter(SPEED, step));
      expect(laneOfX(state[bodyBase(body) + BODY.x] as number)).toBe(1);
    }
    // Dopad: v kroku 74 věc leží na zemi a pravidlo ji odebere.
    expect(flying(playFor(world, 10 + 74 + 1))).toBe(-1);
    expect(flying(playFor(world, 10 + 73 + 1))).toBeGreaterThanOrEqual(0);
  });

  it('the generator throws the same schedule for the same seed and keeps every thing inside its lane', () => {
    expect(sliceThrows(4, DEFAULTS, START_LIVES)).toEqual(sliceThrows(4, DEFAULTS, START_LIVES));
    expect(sliceThrows(4, DEFAULTS, START_LIVES)).not.toEqual(sliceThrows(5, DEFAULTS, START_LIVES));
    for (const item of sliceThrows(4, DEFAULTS, START_LIVES)) expect(Math.abs(item.x - laneX(laneOfX(item.x))) * 2).toBeLessThan(LANES.width);
  });
});

describe('slice level is playable by construction', () => {
  it('passes its own check on 20 seeds for small, default and large goals and any lives', () => {
    for (const seed of SEEDS) for (const goal of [SLICE.items.min, DEFAULTS.items, SLICE.items.max]) for (const lives of [1, START_LIVES, 9]) {
      const params = sliceParams.parse({ items: goal });
      expect(checkSliceLevel(sliceLevel(), sliceThrows(seed, params, lives), params, lives), `seed ${seed}, ${goal} items, ${lives} lives`).toEqual([]);
    }
  });

  it('every game has traps, decoys and groups of two and three', () => {
    const all = SEEDS.flatMap((seed) => sliceThrows(seed, DEFAULTS, START_LIVES).map((item) => ({ ...item, seed })));
    expect(all.some((item) => item.trap)).toBe(true);
    expect(all.some((item) => item.bomb && !item.trap)).toBe(true);
    const sizes = new Map<string, number>();
    for (const item of all) if (!item.bomb) sizes.set(`${item.seed}:${item.group}`, (sizes.get(`${item.seed}:${item.group}`) ?? 0) + 1);
    expect(new Set(sizes.values())).toEqual(new Set([1, 2, 3]));
    // Hrst letí jedním pruhem v jednom tiku: jeden švih ji rozsekne celou.
    for (const item of all) if (!item.bomb) expect(all.filter((other) => !other.bomb && other.seed === item.seed && other.group === item.group).every((other) => other.tick === item.tick && laneOfX(other.x) === laneOfX(item.x))).toBe(true);
  });

  it('fails its check when a trap bomb leaves no time, a throw flies too fast or between lanes, or fruit is missing', () => {
    const throws = sliceThrows(1, DEFAULTS, START_LIVES);
    const level = sliceLevel();
    const fruit = throws.findIndex((item, index) => index > 0 && !item.bomb);
    const target = throws[fruit] as Throw;
    // Bomba týmž pruhem o tik později: robot hrst nestihne rozseknout dřív, než bomba vletí do výšky řezu.
    const tight = [...throws, { ...target, tick: target.tick + 1, bomb: true, trap: true }].sort((a, b) => a.tick - b.tick);
    expect(checkSliceLevel(level, tight, DEFAULTS, START_LIVES).join(' ')).toMatch(/cannot be sliced/);
    const fast = throws.map((item, index) => (index === fruit ? { ...item, speed: 600 } : item));
    expect(checkSliceLevel(level, fast, DEFAULTS, START_LIVES).join(' ')).toMatch(/before the bot can see it/);
    const between = throws.map((item, index) => (index === fruit ? { ...item, x: laneX(1) + LANES.width / 2 } : item));
    expect(checkSliceLevel(level, between, DEFAULTS, START_LIVES).join(' ')).toMatch(/between two lanes/);
    expect(checkSliceLevel(level, throws.filter((_, index) => index !== fruit), DEFAULTS, START_LIVES).join(' ')).toMatch(/pieces of fruit fly/);
  });
});

describe('slice rules', () => {
  // Hrst vyhozená v tiku 10 je ve výšce řezu v ticích 23–71.
  const FLY = 10;
  const IN = FLY + 13;
  const OUT = FLY + 61;

  it('a swing in the lane at the cut height slices and scores; a swing too early, too late or in another lane does not', () => {
    const world = handWorld([thrown(FLY, 0)]);
    const hit = playFor(world, 120, swings({ [IN]: 0 }));
    expect(items(hit)).toBe(1);
    expect(score(hit)).toBe(SLICE.points);
    expect(items(playFor(world, 120, swings({ [IN - 1]: 0 })))).toBe(0);
    expect(items(playFor(world, 120, swings({ [OUT]: 0 })))).toBe(1);
    expect(items(playFor(world, 120, swings({ [OUT + 1]: 0 })))).toBe(0);
    expect(items(playFor(world, 120, swings({ [IN + 5]: 1 })))).toBe(0);
  });

  it('slicing a bomb takes a life on that very tick; sparing it does not', () => {
    const world = handWorld([thrown(FLY, 4, true), thrown(FLY, 0)]);
    const at = IN + 4;
    expect(health(playFor(world, at, swings({ [at]: 4 })))).toBe(START_LIVES);
    expect(health(playFor(world, at + 1, swings({ [at]: 4 })))).toBe(START_LIVES - 1);
    expect(health(playFor(world, 120, swings({ [at]: 0 })))).toBe(START_LIVES);
    // Bomba a ovoce v témže pruhu: švih rozsekne obojí – ovoce se počítá, život ubude.
    const shared = handWorld([thrown(FLY, 2, true, SLICE.spread / 2), thrown(FLY, 2, false, -SLICE.spread / 2)]);
    const both = playFor(shared, at + 1, swings({ [at]: 2 }));
    expect(items(both)).toBe(1);
    expect(health(both)).toBe(START_LIVES - 1);
    // Tři bomby = konec hry.
    const three = handWorld([thrown(FLY, 1, true), thrown(FLY + 100, 3, true), thrown(FLY + 200, 4, true)]);
    expect(outcomeOf(playFor(three, 320, swings({ [IN]: 1, [IN + 100]: 3, [IN + 200]: 4 })))).toBe('lost');
  });

  it('one swing through two or three pieces raises the combo: ×2 and ×3 from a cold start', () => {
    const at = IN + 2;
    const pair = handWorld([thrown(FLY, 1, false, -SLICE.spread / 2), thrown(FLY, 1, false, SLICE.spread / 2)]);
    const two = playFor(pair, at + 1, swings({ [at]: 1 }));
    expect(items(two)).toBe(2);
    expect(score(two)).toBe(2 * SLICE.points * 2);
    const triple = handWorld([thrown(FLY, 3, false, -SLICE.spread), thrown(FLY, 3), thrown(FLY, 3, false, SLICE.spread)]);
    expect(score(playFor(triple, at + 1, swings({ [at]: 3 })))).toBe(3 * SLICE.points * 3);
    // Tytéž dva kusy dvěma švihy daleko od sebe (za oknem komba): ×1 a ×1.
    const apart = handWorld([thrown(FLY, 1), thrown(FLY + 200, 1)]);
    expect(score(playFor(apart, 300, swings({ [at]: 1, [at + 200]: 1 })))).toBe(2 * SLICE.points);
    expect(COMBO.window).toBeLessThan(200);
  });

  it('a dropped piece breaks the combo: the next slice scores ×1', () => {
    const run = [thrown(FLY, 0), thrown(FLY + 30, 1), thrown(FLY + 60, 2)];
    const inRow = { [IN]: 0, [IN + 30]: 1, [IN + 60]: 2 };
    expect(score(playFor(handWorld(run), 200, swings(inRow)))).toBe(SLICE.points * (1 + 2 + 3));
    // Hrst v pruhu 4 vyhozená v tiku 0 dopadne v tiku 74 – mezi druhým a třetím švihem téže série.
    const dropped = handWorld([...run, thrown(0, 4)]);
    const drop = landingStep(SPEED);
    expect(drop).toBeGreaterThan(IN + 30);
    expect(drop).toBeLessThan(IN + 60);
    const state = playFor(dropped, 200, swings(inRow));
    expect(items(state)).toBe(3);
    expect(score(state)).toBe(SLICE.points * (1 + 2 + 1));
  });

  it('dropped fruit is free up to the quota, then each costs a life on its landing tick', () => {
    const launches = Array.from({ length: SLICE.free + 2 }, (_, index) => thrown(FLY + 20 * index, index % LANES.count));
    const world = handWorld(launches);
    const landed = (index: number): number => FLY + 20 * index + landingStep(SPEED);
    expect(health(playFor(world, landed(SLICE.free - 1) + 1))).toBe(START_LIVES);
    expect(health(playFor(world, landed(SLICE.free)))).toBe(START_LIVES);
    expect(health(playFor(world, landed(SLICE.free) + 1))).toBe(START_LIVES - 1);
    expect(health(playFor(world, landed(SLICE.free + 1) + 1))).toBe(START_LIVES - 2);
    // Propadlá bomba nestojí nic.
    expect(health(playFor(handWorld([thrown(FLY, 0, true)]), 200))).toBe(START_LIVES);
  });

  it('wins on the goal count', () => {
    const world = handWorld([thrown(FLY, 0), thrown(FLY + 40, 1), thrown(FLY + 80, 2)], START_LIVES, 2);
    expect(outcomeOf(playFor(world, 200, swings({ [IN]: 0, [IN + 40]: 1 })))).toBe('won');
  });
});

describe('slice gates on the live cell (G1, G2, G4, G5, G6)', () => {
  it('G1: the world bot wins on all 20 seeds in 30–90 s', () => {
    for (const seed of SEEDS) {
      const run = runBot(worldOf(seed));
      expect(run.outcome, `seed ${seed}`).toBe('won');
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeGreaterThanOrEqual(30);
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeLessThanOrEqual(90);
    }
  });

  it('G2 + G6: an idle player never slices and loses to dropped fruit before the horizon; the bot slices the goal and never a bomb', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const idle = playRecord(world, []);
      expect(outcomeOf(idle.state), `seed ${seed}`).toBe('lost');
      expect(idle.state[HEADER.tick], `seed ${seed}: idle lost at the horizon`).toBeLessThan(ARCADE_LIMITS.maxTicks);
      expect(items(idle.state), `seed ${seed}: idle sliced`).toBe(0);
      expect(idle.bombTicks, `seed ${seed}: idle cut a bomb`).toEqual([]);
      // Všechny životy vzalo propadlé ovoce (bombu nečinný nerozsekne); poslední tik jich může vzít víc.
      expect(idle.lifeTicks.length, `seed ${seed}: idle lives`).toBeGreaterThanOrEqual(START_LIVES);
      const bot = playRecord(world, runBot(world).inputs);
      expect(items(bot.state), `seed ${seed}: bot sliced`).toBeGreaterThanOrEqual(DEFAULTS.items);
      expect(bot.bombTicks, `seed ${seed}: bot cut a bomb`).toEqual([]);
      expect(health(bot.state), `seed ${seed}: bot lost a life`).toBe(START_LIVES);
    }
  });

  it('a player who slashes every lane cuts the bombs and loses every life to them', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const mash = Array.from({ length: ARCADE_LIMITS.maxTicks }, (_, tick): InputEvent => ({ tick, buttons: BUTTON.TAP, axis: axisOfLane(tick % LANES.count) }));
      const run = playRecord(world, mash);
      expect(outcomeOf(run.state), `seed ${seed}`).toBe('lost');
      // Každý ztracený život přišel v tiku, kdy švih rozsekl bombu (mashing nic nepropustí).
      expect(run.lifeTicks.every((tick) => run.bombTicks.includes(tick)), `seed ${seed}: lives ${run.lifeTicks}, bombs ${run.bombTicks}`).toBe(true);
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

  it('G5: lives, combo (with multi-piece swings) and the end bonus are in the live world', () => {
    const world = worldOf(3);
    expect(world.initial[HEADER.counters + COUNTER.health]).toBe(START_LIVES);
    const cut = world.rules.find((ref) => ref.id === 'slice_cut');
    expect(cut?.params.combo).toBeTypeOf('number');
    expect(world.rules.some((ref) => ref.id === 'score_bonus')).toBe(true);
    let best = 1;
    let multi = 0;
    for (const seed of [3, 4, 5]) {
      const seeded = worldOf(seed);
      const program = loadProgram(seeded, ARCADE_LIBRARY);
      const state = instantiate(seeded);
      const inputs = runBot(seeded).inputs;
      let next = 0;
      for (let tick = 0; outcomeOf(state) === 'running' && tick < ARCADE_LIMITS.maxTicks; tick += 1) {
        while (next < inputs.length && inputs[next]!.tick < tick) next += 1;
        const effects: readonly ArcadeEffect[] = step(state, inputs[next]?.tick === tick ? inputs[next]! : NO_INPUT, program);
        for (const effect of effects) if (effect.kind === 'combo') best = Math.max(best, effect.multiplier);
        if (effects.filter((effect) => effect.kind === 'count' && effect.counter === 'items').length >= 2) multi += 1;
      }
    }
    expect(best).toBeGreaterThanOrEqual(3);
    expect(multi, 'the bot cut two or three pieces with one swing').toBeGreaterThan(0);
  });

  it('witnesses slice, score and the lanes move in the bot run, and the bomb harms in its probe', () => {
    if (spec === null) throw new Error('slice.default is not a live cell');
    const made = arcadeWorldOf(spec, 2);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    const verbs = new Set(verdict.witnesses.map((witness) => witness.verb));
    for (const verb of ['slice', 'score', 'lanes', 'hazard']) expect(verbs.has(verb), verb).toBe(true);
    expect(verdict.failures).toEqual([]);
  });
});

describe('slice difficulty band (G3 on 20 seeds; the gate itself is difficulty.test.ts)', () => {
  const rate = (profile: BotProfile): number => SEEDS.filter((seed) => runBot(worldOf(seed), undefined, { profile }).outcome === 'won').length / SEEDS.length;
  it('novice wins 0.3–0.7, intermediate at least 0.8', () => {
    expect(Object.keys(BOT_PROFILES)).toEqual(['novice', 'intermediate']);
    const novice = rate('novice');
    const intermediate = rate('intermediate');
    expect(novice, `novice ${novice}`).toBeGreaterThanOrEqual(0.3);
    expect(novice, `novice ${novice}`).toBeLessThanOrEqual(0.7);
    expect(intermediate, `intermediate ${intermediate}`).toBeGreaterThanOrEqual(0.8);
  });

  it('the bot never slashes a lane while a bomb is at the cut height there: it waits for the bomb to drop below', () => {
    // Bomba vyletí o dva tiky dřív než ovoce týmž pruhem: ve výšce řezu je v ticích 23–71, ovoce 25–73.
    const world = handWorld([thrown(10, 2, true, SLICE.spread / 2), thrown(12, 2, false, -SLICE.spread / 2)], START_LIVES, 1);
    const run = runBot(world);
    expect(run.outcome).toBe('won');
    expect(run.inputs.filter((input) => (input.buttons & BUTTON.TAP) !== 0).map((input) => input.tick)).toEqual([72]);
    const played = playRecord(world, run.inputs);
    expect(played.bombTicks).toEqual([]);
    expect(health(played.state)).toBe(START_LIVES);
  });

  it('the bot piece is registered and reacts like the generator assumes', () => {
    expect(ARCADE_LIBRARY.bots.slice_bot).toBe(sliceBot);
    expect(sliceBot.reactionTicks).toBe(8);
    // Rozpis výhozů jde do pravidla beze změny (žádná věc se neztratí cestou).
    const throws = sliceThrows(2, DEFAULTS, START_LIVES);
    expect(worldOf(2).rules.find((ref) => ref.id === 'slice_cut')?.params.launches).toEqual(launchesOf(throws));
    expect(throws.filter((item) => !item.bomb)).toHaveLength(DEFAULTS.items + SLICE.free + START_LIVES - 1);
  });
});
