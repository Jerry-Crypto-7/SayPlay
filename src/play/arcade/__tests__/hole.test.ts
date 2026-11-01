/**
 * Díra (P66 T6): díra polyká věci z věty menší než ona a roste po stupních. Hlídá:
 * - **práh velikosti a stupně** (pin): díra stupně `t` polkne věc třídy `t`, věc třídy `t + 1` ji zastaví a nespadne
 *   – i když díra jede přímo na ni; největší věc jde polknout jen ve stupni 4, a ten je jen v posledním kole;
 * - růst z hmoty (body třídy × vzácnost, bez komba), kolo s vlastními hodinami, kombo jako zdroj háčků;
 * - robot vyhraje, nečinný hráč prohraje na hodinách kola, slabý robot (`mistakes`) prohraje, dvě přehrání týž hash,
 *   publikační brána projde na 10 semínkách;
 * - modul žánru: věci věty jsou těla světa, kulisy ze sady místa, meze parametrů, ruční spec e2e je aktuální.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../compile';
import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeInput,
  type ArcadeWorld,
  BODY,
  type BodyInit,
  COUNTER,
  FLAG,
  HEADER,
  type InputEvent,
  NO_INPUT,
  RESTITUTION_SHIFT,
  bodyBase,
  nativeRule,
} from '../contract';
import { hooksOf, inBreak, roundOf, withHooks } from '../hooks';
import { RARITY_SCORE, ROUNDS } from '../hooks/contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { arenaAxis } from '../pieces/arena';
import { HOLE, HOLE_BODIES, blockDistance, classCounts, growthAt, holeParts, holeSeconds, massOf, needOf, roundStartOf, swallows, tierOf } from '../pieces/hole';
import { HOLE_BOT, mistakeWindow } from '../pieces/hole-bot';
import { runBot, verifyArcade } from '../verify';
import type { GenreModule } from '../../genre/contract';
import { holeGenre, holeKinds, kitClass, thingClass } from '../../genre/hole';
import { compileWith, readGenreSpec } from '../../genre/index';
import { type GameSpecV1, readGameSpec } from '../../spec';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);
const SENTENCE = { genre: 'hole', mode: 'default', hero: 'black hole', setting: 'busy city', cast: [{ label: 'car', does: 'collect' }, { label: 'person', does: 'collect' }] } as const;
/** Slabý robot: v 85 % oken jede do věci větší než díra. */
const WEAK = 850;

/** Hra věty jako ruční spec e2e: modul přímo (`compileWith`), buňku receptu díra do T12 nemá – jako šipky. */
function specOf(params: Readonly<Record<string, number>> = {}): GameSpecV1 {
  const read = readGenreSpec({ ...SENTENCE, params });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileWith(holeGenre as GenreModule, read.value);
}
const SPEC = specOf();

const worlds = new Map<number, ArcadeWorld>();
function worldOf(seed: number, spec: GameSpecV1 = SPEC): ArcadeWorld {
  const cached = spec === SPEC ? worlds.get(seed) : undefined;
  if (cached !== undefined) return cached;
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  if (spec === SPEC) worlds.set(seed, made.world);
  return made.world;
}

const at = (state: Int32Array, body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;
const alive = (state: Int32Array, body: number): boolean => (at(state, body, 'flags') & FLAG.alive) !== 0;
const AHEAD = arenaAxis(0, 1);

interface HandOptions {
  readonly rounds?: number;
  readonly need?: number;
  readonly seconds?: number;
  readonly rarity?: boolean;
  /** Úprava stavu v tiku 0 (hmota, kolo, poloha). */
  readonly edit?: (state: Int32Array) => void;
}

/** Ruční pole: díra v počátku, finále daleko v rohu (nebo `finale`), věci `things` (třída, x, z). */
function handWorld(things: readonly (readonly [cls: number, x: number, z: number])[], options: HandOptions = {}, finale: readonly [number, number] = [15000, 15000]): ArcadeWorld {
  const rounds = options.rounds ?? 1;
  const need = options.need ?? 1000;
  const thing = (cls: number, x: number, z: number): BodyInit => ({ role: 'collectible', kind: `class-${String(cls)}`, x, y: 0, z, w: HOLE.sizes[cls] as number, h: HOLE.sizes[cls] as number, d: HOLE.sizes[cls] as number, solid: false });
  const bodies: BodyInit[] = [
    { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: HOLE.tiers[0] as number, h: 200, d: HOLE.tiers[0] as number, solid: false },
    thing(4, finale[0], finale[1]),
    ...things.map(([cls, x, z]) => thing(cls, x, z)),
  ];
  const keeper = bodies.length;
  const shape = { keeper, rounds, need };
  const field = { first: HOLE_BODIES.first, count: Math.max(1, things.length), finale: HOLE_BODIES.finale };
  const rules = [
    { id: 'hole_eat', params: { ...field } },
    { id: 'hole_round', params: { ...shape, seconds: options.seconds ?? HOLE.seconds.default } },
  ];
  const hooked = withHooks({ level: { bodies, length: 0 }, rules, bot: { id: 'hole_bot', params: { half: HOLE.half, ...shape, ...field } } }, 1, { rounds, clear: 'win', ...(options.rarity === true ? { rarity: true } : {}) });
  // Kusy díry čtou počítadlo háčků; generátor ho má vždy (vzácnost), jedno kolo bez vzácnosti ho od `withHooks` nedostane (T10a).
  const counter: BodyInit = { role: 'thing', kind: 'player', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true };
  const level = hooked.keeper === undefined ? { ...hooked.level, bodies: [...hooked.level.bodies, counter] } : hooked.level;
  const built = buildWorld({ seed: 1, control: { id: 'hole', params: { half: HOLE.half, ...shape, ...field } }, rules: hooked.rules, bot: hooked.bot, level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  if (options.edit === undefined) return built.world;
  const state = Int32Array.from(built.world.initial);
  options.edit(state);
  return { ...built.world, initial: Array.from(state) };
}

/** Hmota a kolo v tiku 0 tak, aby díra měla stupeň `tier` (kolo ručního pole je poslední, cíl 1000). */
const tierEdit = (tier: number) => (state: Int32Array): void => {
  const mass = tier === 4 ? 1000 : tier === 0 ? 0 : (growthAt({ rounds: 1, need: 1000 })[tier - 1] as number);
  state[HEADER.counters + COUNTER.ammo] = mass;
  // Stupeň 4 = celý cíl posledního kola od jeho začátku: kolo už „připravené“ s hmotou začátku 0.
  if (tier === 4) state[bodyBase(0) + BODY.aux0] = 1;
};

/** Stav po `ticks` tikách s osou `axis` (nebo vstupem z `plan`); efekty do `effects`. */
function playFor(world: ArcadeWorld, ticks: number, axis: number | ((state: Int32Array) => ArcadeInput) = 0, effects?: ArcadeEffect[], edits: Readonly<Record<number, (state: Int32Array) => void>> = {}): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < ticks && outcomeOf(state) === 'running'; tick += 1) {
    edits[tick]?.(state);
    const input = typeof axis === 'number' ? (axis === 0 ? NO_INPUT : { buttons: 0, axis }) : axis(state);
    const fired = step(state, input, program);
    effects?.push(...fired);
  }
  return state;
}

/** Robot světa s reakcí jako `runBot`, ale s vlastním horizontem (slabý robot smí hrát déle než 90 s). */
function playBot(world: ArcadeWorld, horizon: number): { readonly outcome: string; readonly tick: number } {
  const piece = ARCADE_LIBRARY.bots[world.bot.id]!;
  const params = piece.params.parse(world.bot.params);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const history: Int32Array[] = [];
  const issued: ArcadeInput[] = [];
  for (let tick = 0; tick < horizon && outcomeOf(state) === 'running'; tick += 1) {
    history.push(state.slice());
    if (history.length > piece.reactionTicks + 1) history.shift();
    const lag = history.length - 1;
    const input = piece.decide({ state: history[0]!, player: state[HEADER.player] as number, tick: tick - lag, recent: issued.slice(issued.length - lag) }, params);
    issued.push(input);
    step(state, input, program);
  }
  return { outcome: outcomeOf(state), tick: state[HEADER.tick] as number };
}

/** Efekty celého přehrání záznamu `inputs`. */
function effectsOf(world: ArcadeWorld, inputs: readonly InputEvent[]): { readonly effects: ArcadeEffect[]; readonly state: Int32Array } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const effects: ArcadeEffect[] = [];
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    effects.push(...step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program));
  }
  return { effects, state };
}

describe('hole: the size threshold and the tiers (pin)', () => {
  it('a tier swallows exactly the classes up to its own: the next class up never fits', () => {
    for (let tier = 0; tier < HOLE.tiers.length; tier += 1) {
      const hole = HOLE.tiers[tier] as number;
      for (let cls = 0; cls < HOLE.sizes.length; cls += 1) expect(swallows(hole, HOLE.sizes[cls] as number, 0, 0), `tier ${tier} class ${cls}`).toBe(cls <= tier);
      // Věc spadne jen se středem v díře o půl svého poloměru; o kus dál zůstane na okraji.
      const size = HOLE.sizes[tier] as number;
      const reach = Math.floor((hole - Math.trunc(size / 2)) / 2);
      expect(swallows(hole, size, reach, 0)).toBe(true);
      expect(swallows(hole, size, reach + 2, 0)).toBe(false);
    }
  });

  it.each([0, 1, 2, 3])('a tier-%i hole driven at a thing one class bigger stops before it and the thing stays', (tier) => {
    const world = handWorld([[tier + 1, 0, 8000]], { edit: tierEdit(tier) });
    const state = playFor(world, 600, AHEAD);
    expect(outcomeOf(state)).toBe('running');
    expect(at(state, 0, 'w')).toBe(HOLE.tiers[tier]);
    expect(alive(state, HOLE_BODIES.first), 'the bigger thing fell in').toBe(true);
    // Zastaví se před věcí (`blockDistance`), dál nejede – kolize díru nezabije, jen zastaví.
    const gap = 8000 - at(state, 0, 'z');
    expect(gap).toBeGreaterThanOrEqual(blockDistance(HOLE.tiers[tier] as number, HOLE.sizes[tier + 1] as number) - HOLE.speeds[tier]!);
    expect(at(state, 0, 'vz')).toBeLessThanOrEqual(1);
  });

  it.each([0, 1, 2, 3])('a tier-%i hole swallows a thing of its own class and gains its points as mass', (tier) => {
    const before = tierEdit(tier);
    const world = handWorld([[tier, 0, 8000]], { edit: before });
    const start = massOf(world.initial);
    const state = playFor(world, 600, AHEAD);
    expect(alive(state, HOLE_BODIES.first)).toBe(false);
    expect(massOf(state) - start).toBe(HOLE.points[tier]);
  });

  it('the biggest thing blocks a tier-3 hole and falls only into the tier-4 hole of the last round, which wins', () => {
    const blocked = playFor(handWorld([[0, -9000, -9000]], { edit: tierEdit(3) }, [0, 9000]), 600, AHEAD);
    expect(alive(blocked, HOLE_BODIES.finale)).toBe(true);
    expect(outcomeOf(blocked)).toBe('running');
    const top = playFor(handWorld([[0, -9000, -9000]], { edit: tierEdit(4) }, [0, 9000]), 600, AHEAD);
    expect(at(top, 0, 'w')).toBe(HOLE.tiers[4]);
    expect(alive(top, HOLE_BODIES.finale)).toBe(false);
    expect(outcomeOf(top)).toBe('won');
  });

  it('tier 4 only comes in the last round: a full round target before it keeps the hole at tier 3', () => {
    const world = handWorld([[0, 0, 9000]], { rounds: 3, need: 60 });
    const state = Int32Array.from(world.initial);
    state[HEADER.counters + COUNTER.ammo] = 3 * 60;
    expect(roundOf(state, hooksOf(world.rules)!.keeper as number)).toBe(0);
    expect(tierOf(state, { keeper: hooksOf(world.rules)!.keeper as number, rounds: 3, need: 60 })).toBe(3);
  });
});

describe('hole: growth, rarity, combo and rounds', () => {
  it('the hole grows by tiers as it swallows and never shrinks', () => {
    const cones = Array.from({ length: 30 }, (_, k) => [0, 0, 2000 + k * 700] as const);
    const shape = { rounds: 1, need: 100 };
    const world = handWorld(cones, shape);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const widths: number[] = [];
    for (let tick = 0; tick < 900 && outcomeOf(state) === 'running'; tick += 1) {
      step(state, { buttons: 0, axis: AHEAD }, program);
      widths.push(at(state, 0, 'w'));
    }
    const [first, second] = growthAt(shape);
    expect(massOf(state)).toBeGreaterThanOrEqual(second as number);
    expect(new Set(widths)).toEqual(new Set([HOLE.tiers[0], HOLE.tiers[1], HOLE.tiers[2]]));
    for (let k = 1; k < widths.length; k += 1) expect(widths[k]).toBeGreaterThanOrEqual(widths[k - 1] as number);
    expect(first).toBeLessThan(second as number);
  });

  it('a rare or epic thing gives its rarity times the points as mass, the combo only multiplies the score', () => {
    // Tělo 2 dostane los v tiku 0; v tiku 1 se přepíše na epickou (kód 3 v bitech odrazu, `rarity.ts`).
    const epic = (state: Int32Array): void => {
      const flags = bodyBase(HOLE_BODIES.first) + BODY.flags;
      state[flags] = ((state[flags] as number) & ~(0x3 << RESTITUTION_SHIFT)) | (3 << RESTITUTION_SHIFT);
    };
    const effects: ArcadeEffect[] = [];
    const state = playFor(handWorld([[1, 0, 4000]], { rarity: true, edit: tierEdit(1) }), 400, AHEAD, effects, { 1: epic });
    expect(alive(state, HOLE_BODIES.first)).toBe(false);
    expect(massOf(state) - (growthAt({ rounds: 1, need: 1000 })[0] as number)).toBe(HOLE.points[1]! * RARITY_SCORE.epic);
    expect(effects.some((effect) => effect.kind === 'rare_found' && effect.rarity === 'epic')).toBe(true);
  });

  it('from genre.v6 the swallow rule is a combo source: a quick series multiplies the score and calls the combo', () => {
    const world = worldOf(1);
    const eat = nativeRule(world.rules, 'hole_eat')!;
    expect(typeof eat.params.combo).toBe('number');
    expect(hooksOf(world.rules)?.combo).toBe(eat.params.combo);
    const { effects } = effectsOf(world, runBot(world).inputs);
    const combos = effects.filter((effect): effect is Extract<ArcadeEffect, { kind: 'combo' }> => effect.kind === 'combo');
    expect(Math.max(...combos.map((effect) => effect.multiplier))).toBeGreaterThanOrEqual(3);
    expect(effects.some((effect) => effect.kind === 'callout' && effect.callout === 'combo_2')).toBe(true);
    // Kombo body násobí: některé skóre polknutí je víc než body jeho třídy.
    const scores = effects.filter((effect): effect is Extract<ArcadeEffect, { kind: 'score' }> => effect.kind === 'score').map((effect) => effect.amount);
    expect(scores.some((amount) => !(HOLE.points as readonly number[]).includes(amount))).toBe(true);
  });

  it('the bot clears three rounds, each with its own banner, and wins only when the biggest thing falls in', () => {
    const world = worldOf(1);
    const { effects, state } = effectsOf(world, runBot(world).inputs);
    expect(effects.filter((effect) => effect.kind === 'round_start').map((effect) => (effect as { round: number }).round)).toEqual([0, 1, 2]);
    expect(effects.filter((effect) => effect.kind === 'round_clear').map((effect) => (effect as { round: number }).round)).toEqual([0, 1, 2]);
    expect(outcomeOf(state)).toBe('won');
    expect(alive(state, HOLE_BODIES.finale)).toBe(false);
    expect(at(state, 0, 'w')).toBe(HOLE.tiers[4]);
    // Nálezy podle vzácnosti pro výsledek: díra losuje vzácnost každé věci.
    expect(hooksOf(world.rules)?.rarity).toBeDefined();
  });

  it('each round has its own clock: a cleared round restarts it after the break', () => {
    const cones = [[0, 0, 2000], [0, 0, 2700], [0, 0, 3400]] as const;
    const world = handWorld(cones, { rounds: 2, need: 3, seconds: 60 });
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    let starts: number[] = [];
    for (let tick = 0; tick < 3 * 60 * ARCADE_HZ && outcomeOf(state) === 'running'; tick += 1) {
      step(state, tick < 120 ? { buttons: 0, axis: AHEAD } : NO_INPUT, program);
      starts = [...new Set([...starts, roundStartOf(state, 0)])];
    }
    expect(outcomeOf(state)).toBe('lost');
    expect(starts).toHaveLength(2);
    const second = starts[1] as number;
    expect(second).toBeGreaterThan(90);
    // Prohra přesně na hodinách druhého kola, ne na hodinách hry.
    expect((state[HEADER.tick] as number) - 1 - second).toBe(60 * ARCADE_HZ);
  });
});

describe('hole: the bot wins, the idle player and the weak bot lose, replays match', () => {
  it.each(SEEDS)('seed %i passes the publish gate: the bot wins, the idle player does not, two replays match', (seed) => {
    const verdict = verifyArcade(worldOf(seed));
    expect(verdict.failures).toEqual([]);
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.bot.tick).toBeLessThan(ARCADE_LIMITS.maxTicks);
    expect(verdict.idle.outcome).toBe('lost');
    expect(verdict.replayEqual).toBe(true);
  });

  it('the idle player loses when the first round clock runs out', () => {
    const idle = replay(worldOf(2), [], ARCADE_LIBRARY);
    expect(idle.outcome).toBe('lost');
    // Tři kola si horizont dělí: 29 s na kolo, ne `seconds` 60 (T5a).
    expect(idle.tick).toBe(holeSeconds(HOLE.rounds.default, HOLE.seconds.default) * ARCADE_HZ + 1);
  });

  it.each(SEEDS)('seed %i: the weak bot that ignores the size threshold loses', (seed) => {
    const world = worldOf(seed);
    const weak = playBot({ ...world, bot: { ...world.bot, params: { ...world.bot.params, mistakes: WEAK } } }, HOLE.rounds.default * (HOLE.seconds.default + 10) * ARCADE_HZ);
    expect(weak.outcome).toBe('lost');
  });

  it('two replays of the bot record end in the same hash, another seed builds another city', () => {
    const world = worldOf(3);
    const bot = runBot(world);
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
    expect(arcadeWorldOf(SPEC, 3).ok && (arcadeWorldOf(SPEC, 3) as { world: ArcadeWorld }).world.initial).toEqual(world.initial);
    expect(worldOf(4).initial).not.toEqual(world.initial);
  });

  it('the weak bot window is a fixed share of windows, not chance', () => {
    const windows = Array.from({ length: 1000 }, (_, k) => mistakeWindow(k * HOLE_BOT.window, WEAK)).filter(Boolean).length;
    expect(windows).toBeGreaterThan(780);
    expect(windows).toBeLessThan(920);
    expect(mistakeWindow(5, 0)).toBe(false);
  });

  it.each<Readonly<Record<string, number>>>([{ items: 30 }, { items: 120 }, { rounds: 1 }, { rounds: 2 }, { seconds: 90 }])('the bot also wins with %o', (params) => {
    const spec = specOf(params);
    for (const seed of [1, 2, 3]) {
      const bot = runBot(worldOf(seed, spec));
      expect(bot.outcome, `seed ${seed}`).toBe('won');
    }
  });
});

describe('hole: the slowest win still fits the replay horizon (P66 T5a pin)', () => {
  /**
   * Nejpomalejší vyhraný běh: hráč stojí a každé kolo vyhraje až v posledním tiku jeho hodin (cíl kola mu tam
   * dopíšeme), v posledním kole stejně tak polkne největší věc (díra na ni); každá přestávka běží celá. Běh musí
   * skončit výhrou v horizontu ověření – jinak výzvu z poctivé výhry server odmítne (`score/dare.ts`).
   */
  it.each(Array.from({ length: HOLE.rounds.max - HOLE.rounds.min + 1 }, (_, k) => HOLE.rounds.min + k))('%i round(s) with the longest round clock end inside the horizon', (rounds) => {
    const world = worldOf(1, specOf({ rounds, seconds: HOLE.seconds.max }));
    const round = nativeRule(world.rules, 'hole_round')!.params as { keeper: number; need: number; seconds: number };
    const clock = round.seconds * ARCADE_HZ;
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const finale = bodyBase(HOLE_BODIES.finale);
    while (outcomeOf(state) === 'running' && (state[HEADER.tick] as number) < 4 * ARCADE_LIMITS.maxTicks) {
      if (!inBreak(state, round.keeper) && (state[HEADER.tick] as number) - roundStartOf(state, 0) === clock - 1) {
        state[HEADER.counters + COUNTER.ammo] = (state[HEADER.counters + COUNTER.reserve] as number) + round.need;
        if (roundOf(state, round.keeper) === rounds - 1) {
          state[bodyBase(0) + BODY.x] = state[finale + BODY.x] as number;
          state[bodyBase(0) + BODY.z] = state[finale + BODY.z] as number;
        }
      }
      step(state, NO_INPUT, program);
    }
    expect(outcomeOf(state)).toBe('won');
    expect(state[HEADER.tick]).toBe(rounds * clock + (rounds - 1) * ROUNDS.breakTicks);
    expect(state[HEADER.tick]).toBeLessThanOrEqual(ARCADE_LIMITS.maxTicks);
  });
});

describe('hole: the genre module', () => {
  it('the sentence becomes a playable spec whose things are bodies of the world', () => {
    const read = readGameSpec(SPEC);
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect(SPEC.control).toBe('hole');
    expect(SPEC.roles.map((role) => [role.id, role.label])).toEqual([['player', 'black hole'], ['item1', 'car'], ['item2', 'person']]);
    const world = worldOf(1);
    const kinds = new Set(Array.from({ length: world.initial[HEADER.bodyCount] as number }, (_, body) => world.kinds[world.initial[bodyBase(body) + BODY.kind] as number]));
    expect(kinds.has('thing:item1') && kinds.has('thing:item2')).toBe(true);
    // Kulisy rušného města kolem a nejvyšší z nich jako největší věc.
    expect(kinds.has('gen3d-traffic-cone')).toBe(true);
    expect(world.kinds[world.initial[bodyBase(HOLE_BODIES.finale) + BODY.kind] as number]).toBe('gen3d-glass-office-tower');
    // Pilulka HUD: cíl kola.
    expect(nativeRule(world.rules, 'finish_collected')?.params.need).toBe(needOf(HOLE.items.default, HOLE.rounds.default));
  });

  it('things get their size class from the word, kit props from their height, a big sentence thing is the finale', () => {
    expect([thingClass('apples'), thingClass('people'), thingClass('cars'), thingClass('house')]).toEqual([0, 1, 2, 3]);
    expect([kitClass(0.8), kitClass(1.5), kitClass(3), kitClass(7)]).toEqual([0, 1, 2, 3]);
    const castle = holeKinds({ hero: 'hole', setting: 'park', cast: [{ label: 'castle', does: 'collect' }, { label: 'duck', does: 'collect' }] });
    expect(castle.finale).toBe('thing:item1');
    expect(castle.finaleLabel).toBe('castle');
    expect(castle.kinds.some((kind) => kind.kind === 'thing:item2' && kind.cls === 0)).toBe(true);
    // Místo bez sady kulis bere kulisy rušného města.
    expect(holeKinds({ hero: 'hole', setting: 'school', cast: [] }).finale).toBe('gen3d-glass-office-tower');
  });

  it('the field holds the class mix, the counts and the param bounds of the genre', () => {
    expect(classCounts(60)).toEqual([28, 18, 10, 4]);
    // P66 T12: živý pro výběr – narážky v modulu, buňka receptu v `PRESETS` (`p66-staged.test.ts`).
    expect(holeGenre.availability('default')).toBe('ready');
    expect(holeGenre.paramBounds).toEqual({ items: { min: 30, max: 120 }, rounds: { min: 1, max: 3 }, seconds: { min: 60, max: 90 } });
    expect(readGenreSpec({ ...SENTENCE, params: { rounds: 4 } }).ok).toBe(false);
    const parts = holeParts(1, {});
    expect(parts.issues).toEqual([]);
    expect(parts.level.bodies.length).toBeLessThanOrEqual(ARCADE_LIMITS.maxBodies);
  });

  it('the quick draft reads what the hole swallows', () => {
    const draft = holeGenre.draftFill('a black hole swallows cars and trees in a busy city', null);
    expect(draft.genre).toBe('hole');
    expect(draft.cast?.[0]).toEqual({ label: 'car', does: 'collect' });
  });

  it('the e2e fixture is the compiled sentence, saved as genre.v6', () => {
    // Fixture je uložená hra `genre.v6` (otisk `p68-hash.test.ts` ji tak drží); P68 T1 zvedl jen verzi nových her.
    const fixture = JSON.parse(readFileSync(new URL('../../../../e2e/fixtures/p66-hole-spec.json', import.meta.url), 'utf8')) as unknown;
    expect(fixture).toEqual(JSON.parse(JSON.stringify({ ...SPEC, genre: { ...SPEC.genre, compilerVersion: 'genre.v6' } })));
  });
});
