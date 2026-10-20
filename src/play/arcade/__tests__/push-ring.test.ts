/**
 * Vytlačování z ringu (P54C T12): hrdina a soupeři jsou koule Rapieru na kulatém ringu, výpad hrdiny vystrčí soupeře
 * za okraj. Hlídá společné brány žánru G1 (robot vyhraje 20/20 za 30–90 s), G2 (nečinný hráč nevyhraje), G6 (čítač
 * vystrčených se pohne jen robotovi), G4/G5 a pásmo G3 na 20 semínkách, plus pravidla, která bez dozoru rozhodují
 * o výsledku: pád z ringu stojí život, vystrčit jde jen soupeře zasaženého výpadem (jiného lano zadrží), výpad hrdinu
 * sám nevynese ven, tři kola se zmenšujícím se ringem, odstavení vystrčených bez despawnu fyzikálního tělesa a robot,
 * který tlačí k okraji a sám se okraji vyhýbá.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';
import { createStreams, nextInt } from '@/sim/rng';

import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeEffect, type ArcadeInput, type ArcadeWorld, BODY, BUTTON, COUNTER, FLAG, HEADER, type InputEvent, NO_INPUT, ROLE, bodyBase, bodyHp, graceOf, setBodyHp } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import { releasePhysics } from '../physics/step';
import { loadRapier } from '../physics/world';
import { DIRECTIONS, arenaAxis, axisOfDirection, directionOfAxis } from '../pieces/arena';
import { behaviourPhaseOf, telegraphOf } from '../pieces/behaviours';
import {
  CONTACT,
  PARK,
  PUSH,
  PUSH_BODIES,
  PUSH_ROUNDS,
  backOff,
  checkPush,
  creditOf,
  isRival,
  lungeOut,
  mindOf,
  pushOffsets,
  pushWorldOf,
  pushedOf,
  ringAt,
  rivalVelocity,
  rivalsOf,
  roundOf,
  roundSizes,
  spawnSpots,
} from '../pieces/push-ring';
import { PUSH_BOT, pushBot, pushDecide, pushPoint } from '../pieces/push-ring-bot';
import { BOT_PROFILES, type BotProfile, runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '../../compose/allowed';
import { compileRecipe } from '../../compose/compile';
import { DIRECTOR_PENDING, GENRE_ANSWER_SCHEMA } from '../../director/answer-schema';
import { classifyGenre } from '../../genre/classify';
import { pushGenre } from '../../genre/push';
import { compileGenre, readGenreSpec } from '../../genre/index';
import { readGameSpec } from '../../spec';

const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);

const cell = liveCells().find((candidate) => candidate.id === 'push.default');
const spec = cell === undefined ? null : compileRecipe(assemblyOfCell(cell));

beforeAll(async () => {
  await loadRapier();
});

function build(seed: number): ArcadeWorld {
  if (spec === null) throw new Error('push.default is not a live cell');
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
const at = (state: Int32Array, body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;
const put = (state: Int32Array, body: number, x: number, z: number): void => {
  state[bodyBase(body) + BODY.x] = x;
  state[bodyBase(body) + BODY.z] = z;
};

/** Hrdina (tělo 1), pilot (0), soupeř prvního kola: mysl 4, koule 5 (kola po jednom soupeři). */
const HERO = PUSH_BODIES.hero;
const RIVAL = PUSH_BODIES.first + 1;
/** Soupeř prvního kola je hned odstavený (HP 0): ring je do druhého kola (`breakTicks`) prázdný. */
const noRival = (state: Int32Array): void => setBodyHp(state, RIVAL, 0);

/** Ruční ring: díly žánru, kola `sizes`, posuny 0; `edit` upraví počáteční stav (poloha, zásah, …). */
function handWorld(edit?: (state: Int32Array) => void, sizes: readonly number[] = [1, 1, 1], lives: number = PUSH.lives): ArcadeWorld {
  const parts = pushWorldOf(sizes, [0, 0, 0], lives);
  const built = buildWorld({ seed: 1, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, health: lives }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  if (edit === undefined) return built.world;
  const state = Int32Array.from(built.world.initial);
  edit(state);
  return { ...built.world, initial: Array.from(state) };
}

/** Stav po `ticks` tikách (stav po kroku `t` = `playFor(world, t + 1)`); `edits` mění stav před tikem; Rapier se uvolní. */
function playFor(world: ArcadeWorld, ticks: number, plan: Readonly<Record<number, ArcadeInput>> = {}, edits: Readonly<Record<number, (state: Int32Array) => void>> = {}, effects?: ArcadeEffect[]): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < ticks && outcomeOf(state) === 'running'; tick += 1) {
    edits[tick]?.(state);
    const fired = step(state, plan[tick] ?? NO_INPUT, program);
    effects?.push(...fired);
  }
  releasePhysics(state);
  return state;
}

/** Záznam po tiku jako `replay`, se stavem a nejvyšším kombem. */
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

/** Osa a ťuk směrem `direction` (0 = +z, 8 = +x). */
const toward = (direction: number, buttons = 0): ArcadeInput => ({ axis: axisOfDirection(direction), buttons });
const EAST = 8;
const ticksOf = (input: ArcadeInput, from: number, to: number): Record<number, ArcadeInput> => Object.fromEntries(Array.from({ length: to - from }, (_, k) => [from + k, input]));

describe('push genre is live (P54C T12)', () => {
  it('has a live push.default cell, a ready module and the ring generator', () => {
    expect(cell?.status).toBe('live');
    expect(pushGenre.availability('default')).toBe('ready');
    expect(MODE_GENERATORS.push_ring?.id).toBe('push_ring');
    expect(spec?.control).toBe('push');
    expect(readGameSpec(spec).ok).toBe(true);
    expect(spec?.roles.find((role) => role.id === 'rival')).toMatchObject({ kind: 'chaser', label: 'bull', count: PUSH.rivals.default });
    expect(spec?.objective).toMatchObject({ kind: 'defeat_targets', count: PUSH.rivals.default, role: 'rival' });
    expect(spec?.mechanics.find((mechanic) => mechanic.id === 'health')?.params).toEqual({ max: PUSH.lives });
  });

  it('reads who is pushed out from the sentence, takes the count from it and keeps the copy short', () => {
    expect(pushGenre.draftFill('a sumo wrestler pushes rivals out of a bouncy ring', null).cast?.[0]).toEqual({ label: 'rival', does: 'fight' });
    expect(pushGenre.draftFill('a penguin shoves the walruses off the ice', null).cast?.[0]).toEqual({ label: 'walrus', does: 'fight' });
    const read = readGenreSpec({ genre: 'push', mode: 'default', hero: 'cat', setting: 'dojo', cast: [{ label: 'ninja', does: 'fight' }], counts: { enemy: 4 } });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const game = compileGenre(read.value);
    expect(game.roles.find((role) => role.id === 'rival')).toMatchObject({ label: 'ninja', count: 4 });
    expect(game.objective.count).toBe(4);
    expect(game.objective.description).toContain('ninjas');
    expect(game.tutorial.goalLine.length).toBeLessThanOrEqual(50);
    const made = arcadeWorldOf(game, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(made.world.rules.find((ref) => ref.id === 'push_round')?.params.sizes).toEqual([1, 1, 2]);
    expect(readGenreSpec({ genre: 'push', mode: 'default', hero: 'cat', setting: 'dojo', counts: { enemy: 2 } }).ok).toBe(false);
    // Soupeř bez jména („rivals“) je hrdina věty: zápasník sumo proti zápasníkům sumo, ne auto z katalogu.
    const sumo = compileGenre({ genre: 'push', mode: 'default', hero: 'sumo wrestler', setting: 'bouncy ring', cast: [{ label: 'rival', does: 'fight' }] });
    expect(sumo.roles.find((role) => role.id === 'rival')?.label).toBe('sumo wrestler');
    expect(sumo.objective.description).toContain('sumo wrestlers');
  });

  // Věty k žánru vede od T13b klasifikátor, režisér ho nabízí od T14b.
  it('is chosen by the classifier (T13b) and offered by the director (T14b)', () => {
    for (const sentence of ['a sumo wrestler pushes rivals out of a bouncy ring', 'push the other robots off the platform', 'shove everyone out of the ring']) {
      expect(classifyGenre(sentence, null).ranked[0]?.genre, sentence).toBe('push');
    }
    expect(DIRECTOR_PENDING.has('push')).toBe(false);
    const variants = (GENRE_ANSWER_SCHEMA.properties as Record<string, { anyOf: { properties: Record<string, { enum?: unknown[] }> }[] }>).spec.anyOf;
    expect(variants.flatMap((variant) => variant.properties.genre?.enum ?? [])).toContain('push');
  });
});

describe('push rounds and layout', () => {
  it('splits the rivals into three rounds, later rounds bigger, and the check refuses a broken split', () => {
    expect(roundSizes(PUSH.rivals.default)).toEqual([2, 2, 3]);
    expect(roundSizes(PUSH.rivals.min)).toEqual([1, 1, 1]);
    expect(roundSizes(8)).toEqual([2, 3, 3]);
    expect(roundSizes(PUSH.rivals.max)).toEqual([3, 3, 3]);
    for (let rivals = PUSH.rivals.min; rivals <= PUSH.rivals.max; rivals += 1) expect(checkPush(roundSizes(rivals)), String(rivals)).toEqual([]);
    expect(checkPush([1, 4, 1]).join(' ')).toMatch(/outside 1–3/);
    expect(checkPush([2, 2]).join(' ')).toMatch(/rounds/);
  });

  it('draws the entry spots of the three rounds from the layout stream of the seed', () => {
    for (const seed of [1, 2, 3]) {
      const stream = createStreams(seed).layout;
      expect(pushOffsets(seed)).toEqual([0, 1, 2].map(() => nextInt(stream, 0, 31)));
    }
    expect(canonicalHash(worldOf(1))).not.toBe(canonicalHash(worldOf(2)));
  });

  it('rivals enter on the entry circle, never next to the hero', () => {
    for (const [hx, hz] of [[0, 0], [0, PUSH.spawnRadius], [3000, -2000]] as const) {
      for (let offset = 0; offset < 32; offset += 5) {
        const spots = spawnSpots(3, offset, hx, hz);
        expect(spots).toHaveLength(3);
        for (const spot of spots) {
          expect(Math.abs(Math.hypot(spot.x, spot.z) - PUSH.spawnRadius)).toBeLessThanOrEqual(3);
          expect(Math.hypot(spot.x - hx, spot.z - hz)).toBeGreaterThanOrEqual(PUSH.spawnClear);
        }
      }
    }
  });
});

describe('push control', () => {
  const world = handWorld(noRival);

  it('the axis is a direction: the hero speeds up to its top speed and brakes without input', () => {
    // Pilot nese rychlost, kterou ovládání kouli hrdiny nastavilo (Rapier z ní část vezme do valení).
    const run = ticksOf(toward(EAST), 0, 30);
    const moving = playFor(world, 30, run);
    expect(at(moving, 0, 'vx')).toBe(PUSH.speed);
    expect(at(moving, 0, 'vz')).toBe(0);
    expect(at(moving, HERO, 'x')).toBeGreaterThan(1500);
    const start = at(playFor(world, 3, run), 0, 'vx');
    expect(start).toBeGreaterThan(PUSH.accel);
    expect(start).toBeLessThanOrEqual(3 * PUSH.accel);
    // Bez vstupu brzdí o `brake` za tik.
    const braked = at(playFor(world, 32, run), 0, 'vx');
    expect(braked).toBeGreaterThanOrEqual(PUSH.speed - 2 * PUSH.brake - 4);
    expect(braked).toBeLessThanOrEqual(PUSH.speed - PUSH.brake);
    // Pilot stojí na hrdinovi (chování míří na něj).
    expect(Math.abs(at(moving, 0, 'x') - at(moving, HERO, 'x'))).toBeLessThanOrEqual(PUSH.speed + 5);
  });

  it('TAP lunges along the facing, ignores the axis while it lasts, settles and then has to recover', () => {
    const plan = { 0: toward(EAST, BUTTON.TAP), 3: toward(0) };
    expect(at(playFor(world, 1, plan), 0, 'vx')).toBe(PUSH.lunge.speed);
    // Osa během výpadu nic nemění: pořád na východ plnou rychlostí výpadu.
    const turned = playFor(world, 4, plan);
    expect([at(turned, 0, 'vx'), at(turned, 0, 'vz')]).toEqual([PUSH.lunge.speed, 0]);
    expect(at(playFor(world, PUSH.lunge.ticks, plan), 0, 'vx')).toBe(PUSH.lunge.speed);
    // První tik po výpadu hrdina zabrzdí na `settle`.
    const settled = playFor(world, PUSH.lunge.ticks + 1, { 0: toward(EAST, BUTTON.TAP) });
    expect(Math.hypot(at(settled, 0, 'vx'), at(settled, 0, 'vz'))).toBeLessThanOrEqual(PUSH.lunge.settle + 1);
    expect(at(settled, 0, 'aux1')).toBeLessThan(0);
    // Ťuk během zotavení výpad nespustí; po zotavení ano.
    const again = PUSH.lunge.ticks + 10;
    expect(at(playFor(world, again + 1, { 0: toward(EAST, BUTTON.TAP), [again]: toward(EAST, BUTTON.TAP) }), 0, 'vx')).toBeLessThan(PUSH.lunge.speed);
    const ready = PUSH.lunge.ticks + PUSH.lunge.recover;
    expect(at(playFor(world, ready + 1, { 0: toward(EAST, BUTTON.TAP), [ready]: toward(EAST, BUTTON.TAP) }), 0, 'vx')).toBe(PUSH.lunge.speed);
  });

  it('a lunge never carries the hero over the edge on its own', () => {
    expect(lungeOut(PUSH.radius - PUSH.lunge.edgeStop + 50, 0, EAST, PUSH.radius)).toBe(true);
    expect(lungeOut(PUSH.radius - PUSH.lunge.edgeStop + 50, 0, EAST + 16, PUSH.radius)).toBe(false);
    expect(lungeOut(PUSH.radius - PUSH.lunge.edgeStop - 50, 0, EAST, PUSH.radius)).toBe(false);
    // Z místa 4,5 m od středu by celý výpad ven (2,4 m) hrdinu vynesl za okraj: skončí u okraje, hrdina nespadne.
    const start = 4500;
    expect(start + PUSH.lunge.speed * PUSH.lunge.ticks).toBeGreaterThan(PUSH.radius + 200);
    const near = handWorld((state) => {
      noRival(state);
      put(state, HERO, start, 0);
    });
    let farthest = 0;
    for (let ticks = 1; ticks <= 60; ticks += 1) {
      const state = playFor(near, ticks, { 0: toward(EAST, BUTTON.TAP) });
      expect(health(state)).toBe(PUSH.lives);
      farthest = Math.max(farthest, at(state, HERO, 'x'));
    }
    expect(farthest).toBeGreaterThan(PUSH.radius - PUSH.lunge.edgeStop - 300);
    expect(farthest).toBeLessThan(PUSH.radius);
  });

  it('rivals back off after their dash, never wish to leave near the edge and brake hard going out', () => {
    expect(backOff(1000, 0, 0, 0)).toEqual([PUSH.backOff.speed, 0]);
    expect(backOff(PUSH.backOff.range, 0, 0, 0)).toEqual([0, 0]);
    // Uprostřed jen zrychlení soupeře, u okraje ven brzda okraje; přání ven se zahodí a táhne ho dovnitř.
    expect(rivalVelocity(0, 0, 100, 0, 0, 0, PUSH.radius)).toEqual([100 - PUSH.rivalAccel, 0]);
    expect(rivalVelocity(0, 0, 0, 0, 300, 0, PUSH.radius, true)).toEqual([PUSH.rivalDashAccel, 0]);
    const x = PUSH.radius - PUSH.edgeGuard / 3;
    expect(rivalVelocity(x, 0, 100, 0, 0, 0, PUSH.radius)).toEqual([100 - PUSH.edgeBrake, 0]);
    const [vx] = rivalVelocity(x, 0, 0, 0, 80, 0, PUSH.radius);
    expect(vx).toBeLessThan(0);
  });
});

describe('push ring rules', () => {
  /** Soupeř prvního kola na `x` (osa +x), s tiky zásahu výpadem `credit`. */
  const rivalAt = (x: number, credit: number) => (state: Int32Array) => {
    put(state, RIVAL, x, 0);
    put(state, mindOf(RIVAL), x, 0);
    setBodyHp(state, RIVAL, 1 + credit);
  };

  it('a rival the hero lunged into and that is past the edge is out: counted, scored and parked, never despawned', () => {
    const world = handWorld(rivalAt(PUSH.radius + 200, 30));
    const effects: ArcadeEffect[] = [];
    const out = playFor(world, 1, {}, {}, effects);
    expect(pushedOf(out)).toBe(1);
    expect(score(out)).toBe(PUSH.points);
    expect(bodyHp(out, RIVAL)).toBe(0);
    expect(effects.some((effect) => effect.kind === 'despawn')).toBe(false);
    const parked = playFor(world, 2);
    expect(isRival(parked, RIVAL)).toBe(false);
    expect(alive(parked, RIVAL)).toBe(true);
    expect([at(parked, RIVAL, 'role'), at(parked, mindOf(RIVAL), 'role')]).toEqual([ROLE.obstacle, ROLE.obstacle]);
    expect(at(parked, RIVAL, 'z')).toBe(PARK.z + RIVAL * PARK.step);
    expect(pushedOf(parked)).toBe(1);
  });

  it('a rival nobody lunged into stays in: the rope holds it at the edge', () => {
    const world = handWorld(rivalAt(PUSH.radius + 200, 0));
    for (const ticks of [1, 30, 90]) {
      const state = playFor(world, ticks);
      expect(pushedOf(state)).toBe(0);
      expect(isRival(state, RIVAL)).toBe(true);
      expect(Math.hypot(at(state, RIVAL, 'x'), at(state, RIVAL, 'z'))).toBeLessThanOrEqual(PUSH.radius + 60);
    }
  });

  it('only a lunge marks a rival: walking into it does not', () => {
    const world = handWorld(rivalAt(2200, 0));
    const lunged = playFor(world, 8, { 0: toward(EAST, BUTTON.TAP) });
    expect(creditOf(lunged, RIVAL)).toBeGreaterThan(PUSH.credit.ticks - 10);
    const walked = playFor(world, 40, ticksOf(toward(EAST), 0, 40));
    expect(creditOf(walked, RIVAL)).toBe(0);
    // Zásah vyprchá: po `credit.ticks` tikách bez výpadu soupeř spadnout nesmí.
    expect(creditOf(playFor(world, 8 + PUSH.credit.ticks + 5, { 0: toward(EAST, BUTTON.TAP) }), RIVAL)).toBe(0);
  });

  it('the hero past the edge loses a life with grace and stands in the middle the next tick', () => {
    const world = handWorld((state) => put(state, HERO, PUSH.radius + 100, 0));
    const fell = playFor(world, 1);
    expect(health(fell)).toBe(PUSH.lives - 1);
    expect(graceOf(fell, 0)).toBeGreaterThan(0);
    expect(alive(fell, HERO)).toBe(false);
    const back = playFor(world, 2);
    expect(alive(back, HERO)).toBe(true);
    expect(Math.hypot(at(back, HERO, 'x'), at(back, HERO, 'z'))).toBeLessThanOrEqual(30);
    expect(health(back)).toBe(PUSH.lives - 1);
    // Poslední život = prohra.
    const last = handWorld((state) => put(state, HERO, PUSH.radius + 100, 0), [1, 1, 1], 1);
    expect(outcomeOf(playFor(last, 1))).toBe('lost');
  });

  it('an empty ring brings the next round after a break, each rival a mind with its ball right behind it', () => {
    const world = handWorld(rivalAt(PUSH.radius + 200, 30), [1, 2, 1]);
    expect(rivalsOf(playFor(world, PUSH.breakTicks))).toEqual([]);
    const next = playFor(world, PUSH.breakTicks + 1);
    expect(roundOf(next)).toBe(2);
    const rivals = rivalsOf(next);
    expect(rivals).toHaveLength(2);
    for (const rival of rivals) {
      expect(at(next, mindOf(rival), 'kind')).toBe(at(next, PUSH_BODIES.mind, 'kind'));
      expect(at(next, mindOf(rival), 'x')).toBe(at(next, rival, 'x'));
      expect(Math.hypot(at(next, rival, 'x') - at(next, HERO, 'x'), at(next, rival, 'z') - at(next, HERO, 'z'))).toBeGreaterThan(PUSH.spawnClear - 200);
    }
    // Ring se do třetího kola nezmenšuje.
    expect(ringAt(next)).toBe(PUSH.radius);
  });

  it('round three shrinks the ring, and clearing it wins – not a round earlier', () => {
    const world = handWorld(rivalAt(PUSH.radius + 200, 30), [1, 1, 1]);
    // Každý nový soupeř hned za okraj se zásahem výpadu: konec kola, pauza, další kolo.
    const knock = (state: Int32Array): void => {
      for (const rival of rivalsOf(state)) {
        put(state, rival, PUSH.radius + 200, 0);
        setBodyHp(state, rival, 1 + 30);
      }
    };
    const third = 2 * (PUSH.breakTicks + 1);
    const edits = { [PUSH.breakTicks + 2]: knock };
    const started = playFor(world, third + 1, {}, edits);
    expect(roundOf(started)).toBe(PUSH_ROUNDS);
    expect(outcomeOf(started)).toBe('running');
    // Od tiku začátku třetího kola se poloměr zmenšuje lineárně až na `shrinkTo`.
    expect(ringAt(started, third)).toBe(PUSH.radius);
    expect(ringAt(started, third + PUSH.shrinkTicks / 2)).toBe((PUSH.radius + PUSH.shrinkTo) / 2);
    expect(ringAt(started, third + PUSH.shrinkTicks + 30)).toBe(PUSH.shrinkTo);
    const shrinking = playFor(world, third + 1 + 300, {}, edits);
    expect(ringAt(shrinking)).toBeLessThan(PUSH.radius);
    expect(ringAt(shrinking)).toBeGreaterThan(PUSH.shrinkTo);
    const won = playFor(world, third + 5, {}, { ...edits, [third + 2]: knock });
    expect(outcomeOf(won)).toBe('won');
    expect(pushedOf(won)).toBe(3);
  });
});

describe('push bot', () => {
  it('stands behind a rival on the side of the centre, backing off as the rival nears the edge', () => {
    const reach = PUSH.lunge.speed * PUSH.lunge.ticks + Math.ceil((PUSH.speed * PUSH.speed) / (2 * PUSH.brake));
    const backs: number[] = [];
    for (const x of [2500, 4000, 5000, 5500, 6200]) {
      const { at: spot, out } = pushPoint({ x, z: 0 }, { x: 0, z: 0 }, PUSH.radius);
      expect(out).toEqual({ x: 1000, z: 0 });
      expect(spot.z).toBe(0);
      const back = x - spot.x;
      backs.push(back);
      expect(back).toBeGreaterThanOrEqual(CONTACT + PUSH_BOT.gap.min);
      expect(back).toBeLessThanOrEqual(CONTACT + PUSH_BOT.gap.max);
      // Kde to mezera dovolí, výpad i s dobrzděním skončí aspoň `lungeEdge` před okrajem.
      if (back < CONTACT + PUSH_BOT.gap.max) expect(spot.x + reach).toBeLessThanOrEqual(PUSH.radius - PUSH_BOT.lungeEdge + 1);
    }
    expect(backs).toEqual([...backs].sort((a, b) => a - b));
    expect(backs.at(-1)).toBe(CONTACT + PUSH_BOT.gap.max);
    // Soupeř u středu nemá směr k okraji: tlačí se tam, kam od hrdiny leží.
    const middle = pushPoint({ x: 100, z: 0 }, { x: 0, z: -2000 }, PUSH.radius).out;
    expect(middle.z).toBeGreaterThan(990);
    expect(Math.abs(middle.x - 50)).toBeLessThan(5);
  });

  it('heads for the middle near the edge and lunges only when it already faces the rival', () => {
    const near = handWorld((state) => put(state, HERO, PUSH.radius - 400, 0));
    const state = Int32Array.from(near.initial);
    const decided = pushDecide({ state, player: 0, tick: 0, recent: [] });
    expect(directionOfAxis(decided.axis)).toBe(EAST + 16);
    // Hrdina stojí v bodě výpadu za soupeřem (na straně středu), ale čelí na sever: nejdřív se natočí, ťuk až s čelem k soupeři.
    const spot = pushPoint({ x: 3000, z: 0 }, { x: 0, z: 0 }, PUSH.radius).at;
    const facingNorth = handWorld((state) => {
      put(state, HERO, spot.x, spot.z);
      put(state, RIVAL, 3000, 0);
      put(state, mindOf(RIVAL), 3000, 0);
    });
    const north = Int32Array.from(facingNorth.initial);
    const turn = pushDecide({ state: north, player: 0, tick: 0, recent: [] });
    expect(turn.buttons & BUTTON.TAP).toBe(0);
    expect(directionOfAxis(turn.axis)).toBe(EAST);
    north[bodyBase(0) + BODY.aux0] = EAST;
    const lunge = pushDecide({ state: north, player: 0, tick: 0, recent: [] });
    expect(lunge.buttons & BUTTON.TAP).toBe(BUTTON.TAP);
  });

  it('steps sideways out of the line of a rival that is winding up', () => {
    // Nečinný hrdina uprostřed: soupeř dojde a začne varovat (flanker), zamčený cíl leží na hrdinovi.
    const world = handWorld();
    const program = loadProgram(world, ARCADE_LIBRARY);
    const live = instantiate(world);
    for (let tick = 0; tick < 400 && behaviourPhaseOf(live, mindOf(RIVAL)) !== 'telegraph'; tick += 1) step(live, NO_INPUT, program);
    const state = live.slice();
    releasePhysics(live);
    const warning = telegraphOf(state, mindOf(RIVAL));
    if (warning === null) throw new Error('the rival never wound up');
    const decided = pushDecide({ state, player: 0, tick: state[HEADER.tick] as number, recent: [] });
    expect(decided.buttons & BUTTON.TAP).toBe(0);
    const dir = DIRECTIONS[directionOfAxis(decided.axis)] as { dx: number; dz: number };
    const line = { x: warning.aim.x - at(state, RIVAL, 'x'), z: warning.aim.z - at(state, RIVAL, 'z') };
    const cos = (dir.dx * line.x + dir.dz * line.z) / (1000 * Math.hypot(line.x, line.z));
    expect(Math.abs(cos)).toBeLessThan(0.45);
  });

  it('the bot piece is registered with a human reaction', () => {
    expect(ARCADE_LIBRARY.bots.push_bot).toBe(pushBot);
    expect(pushBot.reactionTicks).toBe(8);
    expect(arenaAxis(1, 0)).toBe(axisOfDirection(EAST));
  });
});

describe('push gates on the live cell (G1, G2, G4, G5, G6)', () => {
  it('G1: the world bot wins on all 20 seeds in 30–90 s', () => {
    for (const seed of SEEDS) {
      const run = botRun(seed);
      expect(run.outcome, `seed ${seed}`).toBe('won');
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeGreaterThanOrEqual(30);
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeLessThanOrEqual(90);
    }
  }, 300_000);

  it('G2 + G6: an idle player pushes nobody out and never wins; the bot pushes out every rival', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const idle = playRecord(world, []).state;
      expect(outcomeOf(idle), `seed ${seed}`).toBe('lost');
      expect(pushedOf(idle), `seed ${seed}`).toBe(0);
      expect(idle[HEADER.tick] as number, `seed ${seed}`).toBeLessThanOrEqual(PUSH.seconds * ARCADE_HZ + 1);
      const bot = playRecord(world, botRun(seed).inputs).state;
      expect(pushedOf(bot), `seed ${seed}`).toBe(PUSH.rivals.default);
    }
  }, 300_000);

  it('G4: the same seed builds the same world and the bot record replays to its hash', () => {
    for (const seed of [1, 7, 20]) {
      expect(canonicalHash(build(seed))).toBe(canonicalHash(worldOf(seed)));
      const run = botRun(seed);
      expect(replay(worldOf(seed), run.inputs, ARCADE_LIBRARY).hash).toBe(run.hash);
      expect(replay(worldOf(seed), run.inputs, ARCADE_LIBRARY).hash).toBe(run.hash);
    }
  }, 120_000);

  it('G5: lives, the push-out combo, the clock, the HUD goal and the end bonus are in the live world', () => {
    const world = worldOf(3);
    expect(world.initial[HEADER.counters + COUNTER.health]).toBe(PUSH.lives);
    expect(world.rules.find((ref) => ref.id === 'push_out')?.params.combo).toBeTypeOf('number');
    expect(world.rules.some((ref) => ref.id === 'score_bonus')).toBe(true);
    expect(world.rules.find((ref) => ref.id === 'time_limit')?.params).toEqual({ seconds: PUSH.seconds });
    expect(world.rules.find((ref) => ref.id === 'finish_collected')?.params).toEqual({ need: PUSH.rivals.default });
    const combos = SEEDS.map((seed) => playRecord(worldOf(seed), botRun(seed).inputs).combo);
    expect(Math.max(...combos)).toBeGreaterThanOrEqual(2);
  }, 300_000);

  it('witnesses push, defeat and score in the bot run, and the rival as the threat that shoves the hero out', () => {
    if (spec === null) throw new Error('push.default is not a live cell');
    const made = arcadeWorldOf(spec, 2);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    const verbs = new Set(verdict.witnesses.map((witness) => witness.verb));
    for (const verb of ['push', 'defeat', 'score', 'roam']) expect(verbs.has(verb), verb).toBe(true);
    expect(verdict.witnesses.find((witness) => witness.verb === 'push')?.object?.label).toBe('bull');
    // Sonda hrozby (nečinný hrdina): soupeř ho vystrčí z ringu a svědek to připíše soupeři.
    const rival = verdict.witnesses.find((witness) => witness.verb === 'rival');
    expect(rival?.run).toBe('probe');
    expect(rival?.actor.label).toBe('bull');
    expect(rival?.evidence).toBe('pushed-hero-out-of-ring');
    expect(verdict.failures).toEqual([]);
  }, 120_000);
});

describe('push difficulty band (G3 on 20 seeds; the gate itself is difficulty.test.ts)', () => {
  const rate = (profile: BotProfile): number => SEEDS.filter((seed) => runBot(worldOf(seed), undefined, { profile }).outcome === 'won').length / SEEDS.length;
  it('novice wins 0.3–0.7, intermediate at least 0.8', () => {
    expect(Object.keys(BOT_PROFILES)).toEqual(['novice', 'intermediate']);
    const novice = rate('novice');
    const intermediate = rate('intermediate');
    expect(novice, `novice ${novice}`).toBeGreaterThanOrEqual(0.3);
    expect(novice, `novice ${novice}`).toBeLessThanOrEqual(0.7);
    expect(intermediate, `intermediate ${intermediate}`).toBeGreaterThanOrEqual(0.8);
  }, 400_000);
});
