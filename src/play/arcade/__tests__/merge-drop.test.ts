/**
 * Pouštění a slučování (P54C T11): dávkovač nad nádobou, předměty jsou koule Rapieru a dva stejné v kontaktu se
 * sloučí ve větší. Hlídá společné brány žánru G1 (robot vyhraje 20/20 za 45–90 s), G2 (nečinný hráč nevyhraje – jeho
 * předměty zkamení a nádoba přeteče), G6 (čítač sloučení se pohne jen robotovi), G4/G5 a pásmo G3 na 20 semínkách,
 * plus pravidla, která bez dozoru rozhodují o výsledku: pořadí slučování podle id těles (ne podle pořadí kontaktů
 * fyziky), jen stejné předměty, strop úrovní, víko s vteřinou a životem, vlastní stream fronty, hladový robot a
 * collider slotu, do kterého jádro vrátí sloučený předmět jiné velikosti.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';
import { createStreams, nextInt } from '@/sim/rng';

import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeEffect, type ArcadeInput, type ArcadeWorld, AXIS_MAX, BODY, BUTTON, type BodyInit, COUNTER, FLAG, HEADER, type InputEvent, NO_INPUT, ROLE, bodyBase, bodyHp } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import { releasePhysics } from '../physics/step';
import { loadRapier } from '../physics/world';
import {
  MERGE,
  MERGE_BODIES,
  MERGE_LEVELS,
  QUEUE_LEVELS,
  axisFor,
  checkMerge,
  dropLimit,
  itemLevel,
  mergeQueue,
  mergeWorldOf,
  mergesOf,
  overOf,
  patienceOf,
  sizeOf,
  stoneSize,
  targetOf,
} from '../pieces/merge-drop';
import { mergeBot, mergeTarget } from '../pieces/merge-drop-bot';
import { BOT_PROFILES, type BotProfile, runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '../../compose/allowed';
import { compileRecipe } from '../../compose/compile';
import { DIRECTOR_PENDING, GENRE_ANSWER_SCHEMA } from '../../director/answer-schema';
import { classifyGenre } from '../../genre/classify';
import { mergeGenre } from '../../genre/merge';
import { compileGenre, readGenreSpec } from '../../genre/index';
import { readGameSpec } from '../../spec';

const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);

const cell = liveCells().find((candidate) => candidate.id === 'merge.default');
const spec = cell === undefined ? null : compileRecipe(assemblyOfCell(cell));

beforeAll(async () => {
  await loadRapier();
});

function build(seed: number): ArcadeWorld {
  if (spec === null) throw new Error('merge.default is not a live cell');
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

// Běh robota je nejdražší část souboru: brány ho sdílejí (G4 staví svět znovu, aby porovnal).
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

const health = (state: Int32Array): number => state[HEADER.counters + COUNTER.health] as number;
const score = (state: Int32Array): number => state[HEADER.counters + COUNTER.score] as number;
const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const xOf = (state: Int32Array, body: number): number => state[bodyBase(body) + BODY.x] as number;
const yOf = (state: Int32Array, body: number): number => state[bodyBase(body) + BODY.y] as number;
/** Živé předměty jako [tělo, úroveň]. */
function items(state: Int32Array): [number, number][] {
  const out: [number, number][] = [];
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const level = itemLevel(state, body);
    if (level > 0) out.push([body, level]);
  }
  return out;
}

/** Předmět úrovně `level` jako těleso úrovně (živé od tiku 0). */
const ball = (level: number, x: number, y = 0): BodyInit => {
  const size = sizeOf(level);
  return { role: 'collectible', kind: 'item', x, y, z: 0, w: size, h: size, d: size, solid: false, physics: true, ball: true, restitution: MERGE.restitution, ...(level === MERGE_LEVELS ? { hp: MERGE.popTicks } : {}) };
};

/** První těleso, které ruční svět přidá za předlohy úrovně. */
const EXTRA = MERGE_BODIES.stones + QUEUE_LEVELS;

/** Ruční nádoba: díly žánru, fronta `queue` a tělesa `extra` za předlohami; bez komba a bonusu (ty přidá kompilátor specu). */
function handWorld(extra: readonly BodyInit[] = [], queue: readonly number[] = [1], lives: number = MERGE.lives): ArcadeWorld {
  const parts = mergeWorldOf(queue, lives);
  const built = buildWorld({ seed: 1, control: parts.control, rules: parts.rules, bot: parts.bot, level: { ...parts.level, bodies: [...parts.level.bodies, ...extra] }, health: lives }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Stav po `ticks` tikech se vstupy podle tiku (stav po kroku `t` = `playFor(world, t + 1)`); Rapier se uvolní. */
function playFor(world: ArcadeWorld, ticks: number, plan: Readonly<Record<number, ArcadeInput>> = {}, effects?: ArcadeEffect[]): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < ticks && outcomeOf(state) === 'running'; tick += 1) {
    const fired = step(state, plan[tick] ?? NO_INPUT, program);
    effects?.push(...fired);
  }
  releasePhysics(state);
  return state;
}

/** Záznam po tiku jako `replay`, se stavem a se sloučeními podle tiku. */
function playRecord(world: ArcadeWorld, inputs: readonly InputEvent[]): { readonly state: Int32Array; readonly combo: number } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let combo = 1;
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    for (const effect of step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program)) if (effect.kind === 'combo') combo = Math.max(combo, effect.multiplier);
  }
  releasePhysics(state);
  return { state, combo };
}

const TAP: ArcadeInput = { buttons: BUTTON.TAP, axis: 0 };
const RIGHT: ArcadeInput = { buttons: 0, axis: AXIS_MAX };

describe('merge genre is live (P54C T11)', () => {
  it('has a live merge.default cell, a ready module and the merge generator', () => {
    expect(cell?.status).toBe('live');
    expect(mergeGenre.availability('default')).toBe('ready');
    expect(MODE_GENERATORS.merge_box?.id).toBe('merge_box');
    expect(spec?.control).toBe('merge');
    expect(readGameSpec(spec).ok).toBe(true);
    expect(spec?.roles.find((role) => role.id === 'item')).toMatchObject({ kind: 'collectible', label: 'fruit' });
    expect(spec?.objective).toMatchObject({ kind: 'collect', count: MERGE.need, role: 'item' });
    expect(spec?.mechanics.find((mechanic) => mechanic.id === 'health')?.params).toEqual({ max: MERGE.lives });
  });

  it('reads the dropped thing from the sentence and keeps the copy short', () => {
    expect(mergeGenre.draftFill('a cat merges planets in a glass jar', null).cast?.[0]).toEqual({ label: 'planet', does: 'collect' });
    expect(mergeGenre.draftFill('merge into traffic and race', null).cast ?? []).toEqual([]);
    const read = readGenreSpec({ genre: 'merge', mode: 'default', hero: 'cat', setting: 'kitchen', cast: [{ label: 'gem', does: 'collect' }] });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const game = compileGenre(read.value);
    expect(game.roles.find((role) => role.id === 'item')?.label).toBe('gem');
    expect(game.tutorial.goalLine.length).toBeLessThanOrEqual(50);
    expect(game.objective.description).toContain('gems');
  });

  // Věty k žánru vede od T13b klasifikátor; režisér ho nabídne až při opakování T14 (T14b).
  it('is chosen by the classifier (T13b) and the director does not offer it yet', () => {
    for (const sentence of ['merge the fruits in a jar', 'drop and merge planets like suika', 'combine two gems into a bigger gem']) {
      expect(classifyGenre(sentence, null).ranked[0]?.genre, sentence).toBe('merge');
    }
    expect(DIRECTOR_PENDING.has('merge')).toBe(true);
    const variants = (GENRE_ANSWER_SCHEMA.properties as Record<string, { anyOf: { properties: Record<string, { enum?: unknown[] }> }[] }>).spec.anyOf;
    expect(variants.flatMap((variant) => variant.properties.genre?.enum ?? [])).not.toContain('merge');
  });
});

describe('merge queue', () => {
  it('draws levels 1–3 from its own merge stream, not from the layout of the world', () => {
    expect(mergeQueue(1).slice(0, 16)).toEqual([1, 1, 1, 2, 2, 1, 1, 2, 2, 1, 2, 1, 1, 1, 1, 1]);
    const total = MERGE.weights.reduce((sum, weight) => sum + weight, 0);
    const drawn = (stream: ReturnType<typeof createStreams>['merge']): number[] =>
      Array.from({ length: 40 }, () => {
        const pick = nextInt(stream, 1, total);
        return pick <= (MERGE.weights[0] as number) ? 1 : pick <= (MERGE.weights[0] as number) + (MERGE.weights[1] as number) ? 2 : 3;
      });
    for (const seed of [1, 2, 3]) {
      expect(mergeQueue(seed).slice(0, 40)).toEqual(drawn(createStreams(seed).merge));
      expect(mergeQueue(seed).slice(0, 40)).not.toEqual(drawn(createStreams(seed).layout));
    }
    for (const seed of SEEDS) {
      const queue = mergeQueue(seed);
      expect(new Set(queue)).toEqual(new Set([1, 2, 3]));
      expect(checkMerge(queue), `seed ${seed}`).toEqual([]);
    }
  });

  it('the check refuses a queue that is too short or brings a bigger level', () => {
    expect(checkMerge([1, 2, 3]).join(' ')).toMatch(/drops up to/);
    expect(checkMerge([...mergeQueue(1).slice(1), 4]).join(' ')).toMatch(/outside 1–3/);
  });
});

describe('merge control and drop', () => {
  const world = handWorld([], [2, 1, 3]);

  it('the axis is a spot over the container: the dropper runs there at its speed and stops; no input holds it', () => {
    const reach = dropLimit(sizeOf(1));
    const half = { buttons: 0, axis: AXIS_MAX / 2 };
    // Osa drží cíl: dávkovač jede nejvýš `speed` za tik a na cíli zastaví, i když osa trvá.
    expect(xOf(playFor(world, 3, { 0: half, 1: half, 2: half }), 0)).toBe(3 * MERGE.speed);
    const held = Object.fromEntries(Array.from({ length: 20 }, (_, tick) => [tick, half]));
    expect(xOf(playFor(world, 20, held), 0)).toBe(Math.trunc(reach / 2));
    // Bez vstupu stojí, kde je; dál než nad nádobu nedojede.
    expect(xOf(playFor(world, 40, { 0: RIGHT }), 0)).toBe(MERGE.speed);
    const far = Object.fromEntries(Array.from({ length: 40 }, (_, tick) => [tick, RIGHT]));
    expect(xOf(playFor(world, 40, far), 0)).toBe(reach);
    // Střed nádoby je osa 1 (nula = stát); cíl z osy se trefí na pár milimetrů.
    expect(axisFor(0, reach)).toBe(1);
    for (const x of [-1500, -3, 640, reach]) expect(Math.abs(targetOf(axisFor(x, reach), reach, 0) - x)).toBeLessThanOrEqual(2);
  });

  it('TAP drops the next queued item under the dropper once it is ready; an early TAP does nothing', () => {
    const plan = { 0: RIGHT, 1: RIGHT, 2: RIGHT, 3: RIGHT, 4: RIGHT, 5: RIGHT };
    const early = playFor(world, MERGE.reload + 1, { ...plan, [MERGE.reload - 1]: TAP });
    expect(items(early)).toEqual([]);
    const effects: ArcadeEffect[] = [];
    const dropped = playFor(world, MERGE.reload + 1, { ...plan, [MERGE.reload]: TAP }, effects);
    expect(items(dropped).map(([, level]) => level)).toEqual([2]);
    const [body] = items(dropped)[0] as [number, number];
    expect(xOf(dropped, body)).toBe(6 * MERGE.speed);
    expect(dropped[HEADER.counters + COUNTER.ammo]).toBe(1);
    expect(dropped[HEADER.counters + COUNTER.cooldown]).toBe(MERGE.reload);
    expect(effects.some((effect) => effect.kind === 'spawn')).toBe(true);
    // Další ťuk hned potom nepustí nic: hodiny přebíjí.
    const twice = playFor(world, MERGE.reload + 3, { ...plan, [MERGE.reload]: TAP, [MERGE.reload + 1]: TAP });
    expect(items(twice)).toHaveLength(1);
  });

  it('an item kept past the patience turns into a stone one size bigger, and stones never merge', () => {
    // Kámen z předmětu úrovně 3 má velikost úrovně 4 – vedle něj (dotykem) leží předmět úrovně 4.
    const stony = handWorld([ball(4, -sizeOf(4))], [3]);
    const effects: ArcadeEffect[] = [];
    const ticks = MERGE.reload + patienceOf(MERGE.reload) + 1;
    const state = playFor(stony, ticks + 120, {}, effects);
    const spawn = effects.find((effect) => effect.kind === 'spawn');
    expect(spawn).toMatchObject({ template: MERGE_BODIES.stones + 2, x: 0 });
    const stone = Array.from({ length: state[HEADER.bodyCount] as number }, (_, body) => body).find((body) => alive(state, body) && state[bodyBase(body) + BODY.role] === ROLE.obstacle) as number;
    expect(state[bodyBase(stone) + BODY.w]).toBe(stoneSize(3));
    expect(stoneSize(3)).toBe(sizeOf(4));
    expect(mergesOf(state)).toBe(0);
    expect(alive(state, EXTRA)).toBe(true);
    // Trpělivost s časem klesá k minimu.
    expect(patienceOf(0)).toBe(MERGE.patience);
    expect(patienceOf(60 * ARCADE_HZ)).toBe(MERGE.patienceMin);
  });
});

describe('merge rule', () => {
  it('two equal items in contact merge into one a level up, between them', () => {
    const world = handWorld([ball(1, -250), ball(1, 250)]);
    const state = playFor(world, 1);
    expect(alive(state, EXTRA)).toBe(false);
    expect(alive(state, EXTRA + 1)).toBe(false);
    expect(items(state).map(([, level]) => level)).toEqual([2]);
    expect(Math.abs(xOf(state, (items(state)[0] as [number, number])[0]))).toBeLessThanOrEqual(5);
    expect(mergesOf(state)).toBe(1);
    expect(score(state)).toBe(2 * MERGE.points);
  });

  it('unequal items in contact do not merge', () => {
    const state = playFor(handWorld([ball(1, -575), ball(2, 0)]), 60);
    expect(items(state).map(([, level]) => level).sort()).toEqual([1, 2]);
    expect(mergesOf(state)).toBe(0);
  });

  it('merge order follows the body ids, not the order of the physical contacts', () => {
    // A–B se dotýkají s mezerou 5 mm, B–C se překrývají o 5 mm (hlubší kontakt). Podle id jde A s B, C zbude.
    const world = handWorld([ball(1, -505), ball(1, 0), ball(1, 495)]);
    const state = playFor(world, 1);
    expect([alive(state, EXTRA), alive(state, EXTRA + 1), alive(state, EXTRA + 2)]).toEqual([false, false, true]);
    const merged = items(state).find(([, level]) => level === 2) as [number, number];
    expect(xOf(state, merged[0])).toBeLessThan(-200);
    // Týž svět dvakrát od tiku 0 = týž stav (Rapier i pořadí sloučení jsou deterministické).
    const plan = { 0: RIGHT, [MERGE.reload]: TAP };
    expect(Array.from(playFor(world, 200, plan))).toEqual(Array.from(playFor(world, 200, plan)));
  });

  it('the biggest item never merges: it counts down and pops for points, freeing the container', () => {
    const world = handWorld([ball(MERGE_LEVELS, -950), ball(MERGE_LEVELS, 950)]);
    const first = playFor(world, 1);
    expect(items(first).map(([, level]) => level)).toEqual([MERGE_LEVELS, MERGE_LEVELS]);
    expect(bodyHp(first, EXTRA)).toBe(MERGE.popTicks - 1);
    const before = playFor(world, MERGE.popTicks - 1);
    expect([alive(before, EXTRA), alive(before, EXTRA + 1)]).toEqual([true, true]);
    const after = playFor(world, MERGE.popTicks);
    expect(items(after)).toEqual([]);
    expect(score(after)).toBe(2 * MERGE.popPoints);
    expect(mergesOf(after)).toBe(0);
  });

  it('a merged item that takes over a smaller item’s slot gets a collider of its own size', () => {
    // Dva předměty úrovně 1 puštěné nad sebe se sloučí; větší předmět dostane slot prvního (první mrtvý slot spawnu).
    const world = handWorld([], [1, 1]);
    const state = playFor(world, 220, { [MERGE.reload]: TAP, [2 * MERGE.reload + 1]: TAP });
    expect(mergesOf(state)).toBe(1);
    const [body, level] = items(state)[0] as [number, number];
    expect(level).toBe(2);
    expect(body).toBe(state[HEADER.spawnBase]);
    // Leží na dně: spodek AABB na nule, ne propadlý o rozdíl poloměrů starého collideru.
    expect(Math.abs(yOf(state, body))).toBeLessThanOrEqual(15);
  });
});

describe('merge lid', () => {
  // Pevný sloupek dosahuje nad víko; předmět na něm leží nad víkem a nepadá.
  const pillar: BodyInit = { role: 'platform', kind: 'wall', x: 0, y: 0, z: 0, w: 600, h: MERGE.lid + 200, d: 600, solid: true };
  const world = handWorld([pillar, ball(1, 0, MERGE.lid + 200)]);

  it('an item above the lid for one second is fine; longer spills it and costs a life with grace', () => {
    const second = playFor(world, MERGE.overTicks);
    expect(health(second)).toBe(MERGE.lives);
    expect(alive(second, EXTRA + 1)).toBe(true);
    expect(overOf(second)).toBe(MERGE.overTicks);
    const longer = playFor(world, MERGE.overTicks + 1);
    expect(health(longer)).toBe(MERGE.lives - 1);
    expect(alive(longer, EXTRA + 1)).toBe(false);
    expect(overOf(longer)).toBe(0);
  });

  it('the last life lost to an overflow loses the game', () => {
    const last = handWorld([pillar, ball(1, 0, MERGE.lid + 200)], [1], 1);
    expect(outcomeOf(playFor(last, MERGE.overTicks))).toBe('running');
    expect(outcomeOf(playFor(last, MERGE.overTicks + 1))).toBe('lost');
  });
});

describe('merge bot', () => {
  it('drops above an equal item it would land on first, otherwise into the lowest spot', () => {
    const world = handWorld([ball(1, 1500), ball(2, 700)]);
    const state = playFor(world, 30);
    const [one, two] = [1, 2].map((level) => items(state).find(([, l]) => l === level)?.[0] as number);
    // Nad stejný předmět, i když vedle je dno níž.
    expect(mergeTarget(state, 1, 0)).toBe(xOf(state, one));
    expect(mergeTarget(state, 2, 0)).toBe(xOf(state, two));
    // Úroveň 3 stejný předmět nemá: nejnižší místo je volné dno (mimo dvojku), nejblíž dávkovači.
    const low = mergeTarget(state, 3, 0);
    expect(xOf(state, two) - low).toBeGreaterThanOrEqual(sizeOf(2) / 2 + sizeOf(3) / 2);
    expect(low).toBeGreaterThan(-200);
  });

  it('skips an equal item buried under another one', () => {
    // Předmět úrovně 1 leží pod předmětem úrovně 3: puštěný předmět by dopadl na trojku, ne na jedničku. Viditelná
    // jednička leží výš (na pětce), takže kdyby robot zakopanou nepřeskočil, vybral by ji jako nižší místo.
    const world = handWorld([ball(1, 0), ball(3, 0, sizeOf(1)), ball(5, 1400), ball(1, 1400, sizeOf(5))]);
    const state = playFor(world, 2);
    const visible = items(state).find(([body, level]) => level === 1 && xOf(state, body) > 1000) as [number, number];
    expect(yOf(state, visible[0])).toBeGreaterThan(sizeOf(5) - 50);
    expect(mergeTarget(state, 1, 0)).toBe(xOf(state, visible[0]));
  });

  it('the bot piece is registered and reacts like the patience check assumes', () => {
    expect(ARCADE_LIBRARY.bots.merge_bot).toBe(mergeBot);
    expect(mergeBot.reactionTicks).toBe(8);
  });
});

describe('merge gates on the live cell (G1, G2, G4, G5, G6)', () => {
  it('G1: the world bot wins on all 20 seeds in 45–90 s', () => {
    for (const seed of SEEDS) {
      const run = botRun(seed);
      expect(run.outcome, `seed ${seed}`).toBe('won');
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeGreaterThanOrEqual(45);
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeLessThanOrEqual(90);
    }
  }, 240_000);

  it('G2 + G6: an idle player merges nothing and loses by overflow; the bot merges what the goal needs', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const idle = playRecord(world, []).state;
      expect(outcomeOf(idle), `seed ${seed}`).toBe('lost');
      expect(mergesOf(idle), `seed ${seed}`).toBe(0);
      expect(health(idle), `seed ${seed}`).toBe(0);
      expect(idle[HEADER.tick] as number, `seed ${seed}`).toBeLessThan(MERGE.seconds * ARCADE_HZ);
      // Víc dvojic se může sloučit v témže tiku: výherní tik smí cíl přetáhnout.
      const bot = playRecord(world, botRun(seed).inputs).state;
      expect(mergesOf(bot), `seed ${seed}`).toBeGreaterThanOrEqual(MERGE.need);
      expect(mergesOf(bot), `seed ${seed}`).toBeLessThanOrEqual(MERGE.need + 2);
    }
  }, 240_000);

  it('G4: the same seed builds the same world and the bot record replays to its hash', () => {
    for (const seed of [1, 7, 20]) {
      expect(canonicalHash(build(seed))).toBe(canonicalHash(worldOf(seed)));
      const run = botRun(seed);
      expect(replay(worldOf(seed), run.inputs, ARCADE_LIBRARY).hash).toBe(run.hash);
      expect(replay(worldOf(seed), run.inputs, ARCADE_LIBRARY).hash).toBe(run.hash);
    }
    expect(canonicalHash(worldOf(1))).not.toBe(canonicalHash(worldOf(2)));
  }, 120_000);

  it('G5: lives, the merge combo, the clock and the end bonus are in the live world', () => {
    const world = worldOf(3);
    expect(world.initial[HEADER.counters + COUNTER.health]).toBe(MERGE.lives);
    expect(world.rules.find((ref) => ref.id === 'merge_join')?.params.combo).toBeTypeOf('number');
    expect(world.rules.some((ref) => ref.id === 'score_bonus')).toBe(true);
    expect(world.rules.find((ref) => ref.id === 'time_limit')?.params).toEqual({ seconds: MERGE.seconds });
    expect(world.rules.find((ref) => ref.id === 'finish_collected')?.params).toEqual({ need: MERGE.need });
    const run = playRecord(world, botRun(3).inputs);
    expect(outcomeOf(run.state)).toBe('won');
    expect(run.combo).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('witnesses drop, merge and score in the bot run', () => {
    if (spec === null) throw new Error('merge.default is not a live cell');
    const made = arcadeWorldOf(spec, 2);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    const verbs = new Set(verdict.witnesses.map((witness) => witness.verb));
    for (const verb of ['drop', 'merge', 'score']) expect(verbs.has(verb), verb).toBe(true);
    expect(verdict.witnesses.find((witness) => witness.verb === 'merge')?.object?.label).toBe('fruit');
    expect(verdict.failures).toEqual([]);
  }, 120_000);
});

describe('merge difficulty band (G3 on 20 seeds; the gate itself is difficulty.test.ts)', () => {
  const rate = (profile: BotProfile): number => SEEDS.filter((seed) => runBot(worldOf(seed), undefined, { profile }).outcome === 'won').length / SEEDS.length;
  it('novice wins 0.3–0.7, intermediate at least 0.8', () => {
    expect(Object.keys(BOT_PROFILES)).toEqual(['novice', 'intermediate']);
    const novice = rate('novice');
    const intermediate = rate('intermediate');
    expect(novice, `novice ${novice}`).toBeGreaterThanOrEqual(0.3);
    expect(novice, `novice ${novice}`).toBeLessThanOrEqual(0.7);
    expect(intermediate, `intermediate ${intermediate}`).toBeGreaterThanOrEqual(0.8);
  }, 300_000);
});
