/**
 * Obrana pruhů (P54C T7): vlny nepřátel jdou pěti pruhy k hradbě, hrdina střílí do pruhů a staví obránce.
 * Hlídá společné brány žánru G1 (robot vyhraje 20/20 za 30–90 s, hra 45–90 s), G2 (nečinný nevyhraje),
 * G6 (čítač padlých se pohne jen robotovi), G4/G5 a pásmo G3 na 20 semínkách, plus pravidla, která bez
 * dozoru rozhodují o životech: průlom bere život, boss všechny, obránce stojí nejvýš jeden na pruh, luk
 * přebíjí a kdo jen postaví obránce a dál nic nedělá, prohraje.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, type ArcadeLevel, type ArcadeWorld, BODY, BUTTON, type BodyInit, COUNTER, FLAG, HEADER, type InputEvent, NO_INPUT, START_LIVES, bodyBase, bodyHp } from '../contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import { LANES, LANE_START, axisOfLane, laneOfX, laneX } from '../pieces/lanes';
import { DEFENSE, bonusesOf, breachStep, checkDefenseLevel, copiesOf, defenseBonuses, defenseInView, defenseLevel, defenseMarch, defenseParams, firstOverrun, marchOf, startZ, waveSizes } from '../pieces/lane-defense';
import { EVENT_MARK, LANE_EVENTS } from '../pieces/lane-events';
import { DEFENSE_CALM, defenseBot, defenseView } from '../pieces/lane-defense-bot';
import { WAVE_COUNTER, waveOf } from '../pieces/waves';
import { funMetrics, traceRun } from '../telemetry';
import { BOT_PROFILES, type BotProfile, runBot, verifyArcade } from '../verify';
import { assemblyOfCell, liveCells } from '../../compose/allowed';
import { compileRecipe } from '../../compose/compile';
import { DIRECTOR_PENDING, GENRE_ANSWER_SCHEMA } from '../../director/answer-schema';
import { COUNT_PARAMS } from '../../genre/contract';
import { classifyGenre } from '../../genre/classify';
import { defenseGenre } from '../../genre/defense';
import { compileGenre, readGenreSpec } from '../../genre/index';
import { readGameSpec } from '../../spec';

const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);
const DEFAULTS = defenseParams.parse({});

const cell = liveCells().find((candidate) => candidate.id === 'defense.default');
const spec = cell === undefined ? null : compileRecipe(assemblyOfCell(cell));

function worldOf(seed: number, enemies?: number): ArcadeWorld {
  if (spec === null) throw new Error('defense.default is not a live cell');
  const sized = enemies === undefined ? spec : { ...spec, controlParams: { ...spec.controlParams, tuning: { enemies } } };
  const made = arcadeWorldOf(sized, seed);
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
const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Nepřítel, který v pruhu `lane` vejde do obrazu po kroku `enter − 1` a jde rychlostí `speed`. */
function marcher(lane: number, enter: number, speed: number, hp = 1, boss = false): BodyInit {
  const size = boss ? { w: DEFENSE.boss.w, h: DEFENSE.boss.h, d: DEFENSE.boss.d } : DEFENSE.enemy;
  return { role: 'chaser', kind: 'chaser', x: laneX(lane), y: 0, z: startZ(enter, speed), ...size, solid: false, vz: -speed, kinematic: true, hp };
}

/** Malý svět obrany z ručně položených nepřátel, s kombem jako živá hra; hrdina stojí ve startovním pruhu. */
function handWorld(enemies: readonly BodyInit[], options: { readonly lives?: number; readonly boss?: number; readonly waves?: readonly number[] } = {}) {
  const { wall, castle, bolt, arrow, defender } = DEFENSE;
  const first = 2;
  const templates = first + enemies.length;
  const ids = { bolt: templates, arrow: templates + 1, defender: templates + 2, keeper: templates + 3 };
  const bodies: BodyInit[] = [
    { role: 'player', kind: 'player', x: laneX(LANE_START), y: 0, z: 0, ...DEFENSE.hero, solid: false },
    { role: 'platform', kind: 'castle', x: 0, y: 0, z: wall - castle.d / 2, ...castle, solid: false },
    ...enemies,
    { role: 'projectile', kind: 'bolt', x: 0, y: bolt.y, z: wall, w: bolt.w, h: bolt.h, d: bolt.d, solid: false, template: true, lifetime: bolt.lifetime },
    { role: 'projectile', kind: 'arrow', x: 0, y: arrow.y, z: wall, w: arrow.w, h: arrow.h, d: arrow.d, solid: false, template: true, lifetime: arrow.lifetime },
    { role: 'platform', kind: 'defender', x: 0, y: castle.h, z: wall - castle.d / 2, ...defender, solid: false, template: true },
    { role: 'thing', kind: 'player', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true },
  ];
  const level: ArcadeLevel = { bodies, length: 0, spawnSlots: DEFENSE.spawnSlots };
  const built = buildWorld({
    seed: 1,
    control: { id: 'lanes', params: {} },
    rules: [
      { id: 'defense_shot', params: { bolt: ids.bolt, arrow: ids.arrow, defender: ids.defender, waves: [...(options.waves ?? [])] } },
      // Bez bosse míří `boss` na hradbu – žádný nepřítel ji nemá.
      { id: 'defense_hit', params: { bolt: ids.bolt, boss: options.boss ?? 1, points: DEFENSE.points, bossPoints: DEFENSE.bossPoints, combo: ids.keeper } },
      { id: 'defense_goal', params: {} },
      { id: 'out_of_health', params: {} },
    ],
    bot: { id: 'defense_bot', params: { bolt: ids.bolt, arrow: ids.arrow, defender: ids.defender } },
    level,
    health: options.lives ?? START_LIVES,
  }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return { world: built.world, ...ids };
}

/** Stav po `ticks` tikech se vstupy podle tiku. */
function playFor(world: ArcadeWorld, ticks: number, input: (tick: number) => InputEvent | null = () => null): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < ticks; tick += 1) step(state, input(tick) ?? NO_INPUT, program);
  return state;
}

/** Ťuk do pruhu `lane` v ticích `at`. */
const tapsAt = (lane: number, ...at: readonly number[]) => (tick: number): InputEvent | null => (at.includes(tick) ? { tick, buttons: BUTTON.TAP, axis: axisOfLane(lane) } : null);

/** Držení v pruhu `lane` v ticích `[from, to)`. */
const holdIn = (lane: number, from: number, to: number) => (tick: number): InputEvent | null => (tick >= from && tick < to ? { tick, buttons: BUTTON.HOLD, axis: axisOfLane(lane) } : null);

const defendersIn = (state: Int32Array, template: number): number[] => copiesOf(state, template).map((body) => laneOfX(state[bodyBase(body) + BODY.x] as number));

describe('defense genre is live (P54C T7)', () => {
  it('has a live defense.default cell, a ready module and the lane defense generator', () => {
    expect(cell?.status).toBe('live');
    expect(defenseGenre.availability('default')).toBe('ready');
    expect(MODE_GENERATORS.lane_defense?.id).toBe('lane_defense');
    expect(spec?.control).toBe('lanes');
    expect(readGameSpec(spec).ok).toBe(true);
    expect(spec?.roles.find((role) => role.id === 'chaser')?.label).toBe('goblin');
    expect(spec?.roles.find((role) => role.id === 'castle')?.label).toBe('castle');
  });

  it('reads who marches and what is defended from the sentence: defend, protect, guard, stop', () => {
    const fill = defenseGenre.draftFill('defend the castle from waves of goblins', null);
    expect(fill.cast).toContainEqual({ label: 'goblin', does: 'shoot_at' });
    expect(fill.cast).toContainEqual({ label: 'castle', does: 'reach' });
    const village = defenseGenre.draftFill('a knight protects our village against the orcs', null);
    expect(village.cast).toContainEqual({ label: 'orc', does: 'shoot_at' });
    expect(village.cast).toContainEqual({ label: 'village', does: 'reach' });
    expect(defenseGenre.draftFill('stop the skeletons before they break into the barn', null).cast?.[0]).toEqual({ label: 'skeleton', does: 'shoot_at' });
    // Honič věty jde v obraně taky k hradbě: jinou roli nepřítele žánr nemá.
    const chased = defenseGenre.draftFill('a robot guards the gate while wolves chase it', null);
    expect(chased.cast?.every((item) => item.does === 'shoot_at' || item.does === 'reach')).toBe(true);
    const read = readGenreSpec({ genre: 'defense', mode: 'default', hero: 'fox', setting: 'farm', cast: [{ label: 'rat', does: 'chase_me' }, { label: 'barn', does: 'reach' }], counts: { enemy: 12 } });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const game = compileGenre(read.value);
    expect(game.roles.find((role) => role.id === 'chaser')?.label).toBe('rat');
    expect(game.roles.find((role) => role.id === 'castle')?.label).toBe('barn');
    expect((game.controlParams as { tuning: { enemies: number } }).tuning.enemies).toBe(12);
    expect(COUNT_PARAMS.defense.default?.enemy).toBe('enemies');
    expect(game.tutorial.goalLine.length).toBeLessThanOrEqual(50);
    // Počet z věty nad mezí se ořízne (P54C): žánr zůstane.
    const over = readGenreSpec({ genre: 'defense', mode: 'default', hero: 'fox', setting: 'farm', counts: { enemy: DEFENSE.enemies.max + 1 } });
    expect(over.ok && over.value.counts?.enemy).toBe(DEFENSE.enemies.max);
  });

  // P54C T13: klasifikátor obranu zná – brání se místo před mnoha; kdo se brání sám nebo jednomu, hraje dál souboj a rvačku.
  it('is offered to sentences about holding a place against many (T13) and by the director (T14)', () => {
    for (const sentence of ['defend the castle from waves of goblins', 'protect the village against the orcs', 'tower defense with zombies']) {
      expect(classifyGenre(sentence, null).ranked[0]?.genre, sentence).toBe('defense');
    }
    for (const sentence of ['a knight defends himself in a sword duel', 'a mouse defends its cheese from a hungry cat']) {
      expect(classifyGenre(sentence, null).ranked[0]?.genre, sentence).not.toBe('defense');
    }
    expect(DIRECTOR_PENDING.has('defense')).toBe(false);
    expect(JSON.stringify(GENRE_ANSWER_SCHEMA)).toContain('"defense"');
  });
});

describe('defense level is playable by construction', () => {
  it('passes its own check on 20 seeds for small, default and large waves', () => {
    for (const seed of SEEDS) for (const enemies of [DEFENSE.enemies.min, DEFAULTS.enemies, DEFENSE.enemies.max]) {
      const params = defenseParams.parse({ enemies });
      expect(checkDefenseLevel(defenseLevel(seed, params), params), `seed ${seed}, ${enemies} enemies`).toEqual([]);
    }
  });

  it('four waves end with one boss, faster each wave, and the last two waves charge in pairs', () => {
    expect(waveSizes(DEFAULTS.enemies)).toEqual([5, 7, 8, 10]);
    for (const seed of SEEDS) {
      const march = defenseMarch(seed, DEFAULTS);
      expect(march).toHaveLength(DEFAULTS.enemies);
      expect(march.filter((step) => step.boss)).toEqual([march.at(-1)]);
      const pace = [0, 1, 2, 3].map((wave) => Math.min(...march.filter((step) => step.wave === wave && !step.boss).map((step) => step.speed)));
      expect(pace, `seed ${seed}`).toEqual([...pace].sort((a, b) => a - b));
      // Dvojice = dva útočníci v témže tiku ve dvou pruzích.
      const pairs = march.filter((step, index) => index > 0 && step.speed > 300 && march[index - 1]?.enter === step.enter && march[index - 1]?.speed === step.speed);
      expect(pairs.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      for (const second of pairs) expect(march[march.indexOf(second) - 1]?.lane).not.toBe(second.lane);
      // Boss vejde až po všech, nejdřív kolem `bossAt` (zaokrouhlení rozestupů pár tiků).
      const boss = march.at(-1)!;
      expect(boss.enter).toBeGreaterThan(Math.max(...march.slice(0, -1).map((other) => other.enter)));
      expect(boss.enter).toBeGreaterThanOrEqual(DEFENSE.bossAt - 10);
    }
  });

  it('fails its check when two enemies share a lane, the boss is missing, or a charge outruns the hero', () => {
    const level = defenseLevel(1, DEFAULTS);
    const march = marchOf(level);
    const swapped = (index: number, body: BodyInit): ArcadeLevel => ({ ...level, bodies: level.bodies.map((old, at) => (at === index + 2 ? body : old)) });
    const first = march[0]!;
    // Druhý nepřítel v pruhu prvního, rychlejší a těsně za ním: doběhne ho.
    expect(checkDefenseLevel(swapped(1, marcher(first.lane, first.enter + 1, first.speed * 3)), DEFAULTS).join(' ')).toMatch(/walks into/);
    const lastRegular = march.length - 2;
    expect(checkDefenseLevel(swapped(march.length - 1, marcher(0, march.at(-1)!.enter, 50)), DEFAULTS).join(' ')).toMatch(/boss/);
    // Pět útočníků naráz: sám hrdina s reakcí robota nestihne ani tři.
    const charge = Math.ceil((DEFENSE.far - DEFENSE.enemy.d / 2 - DEFENSE.wall) / 20);
    const rushed = { ...level, bodies: level.bodies.map((old, at) => (at >= lastRegular - 2 && at < lastRegular + 3 ? marcher(at % LANES.count, 2000, charge) : old)) };
    expect(firstOverrun(marchOf(rushed))).toBeGreaterThanOrEqual(0);
    expect(checkDefenseLevel(rushed, DEFAULTS).join(' ')).toMatch(/before the hero alone could shoot it down/);
  });
});

describe('defense rules', () => {
  it('a tap shoots into the tapped lane and downs the nearest enemy there; other lanes stay', () => {
    const { world, bolt } = handWorld([marcher(0, 10, 50), marcher(0, 60, 50), marcher(3, 10, 50)]);
    const shot = playFor(world, 21, tapsAt(0, 20));
    expect(copiesOf(shot, bolt)).toHaveLength(1);
    const state = playFor(world, 60, tapsAt(0, 20));
    expect(items(state)).toBe(1);
    expect(score(state)).toBe(DEFENSE.points);
    expect(alive(state, 2)).toBe(false);
    expect(alive(state, 3)).toBe(true);
    expect(alive(state, 4)).toBe(true);
  });

  it('the bow reloads: a second tap inside the reload does not shoot, one after it does', () => {
    const { world, bolt } = handWorld([marcher(1, 10, 50, 2)]);
    expect(copiesOf(playFor(world, 26, tapsAt(1, 20, 25)), bolt)).toHaveLength(1);
    const early = playFor(world, 80, tapsAt(1, 20, 20 + DEFENSE.reload - 1));
    expect(bodyHp(early, 2)).toBe(1);
    const reloaded = playFor(world, 80, tapsAt(1, 20, 20 + DEFENSE.reload));
    expect(alive(reloaded, 2)).toBe(false);
    expect(items(reloaded)).toBe(1);
  });

  it('an enemy that reaches the wall takes a life on that very tick', () => {
    const speed = 500;
    const { world } = handWorld([marcher(4, 0, speed), marcher(1, 400, 50)]);
    const breach = breachStep(startZ(0, speed), speed, DEFENSE.enemy.d);
    const before = playFor(world, breach);
    expect(health(before)).toBe(START_LIVES);
    expect(alive(before, 2)).toBe(true);
    const after = playFor(world, breach + 1);
    expect(health(after)).toBe(START_LIVES - 1);
    expect(alive(after, 2)).toBe(false);
    expect(items(after)).toBe(0);
    expect(outcomeOf(after)).toBe('running');
  });

  it('the boss at the wall takes every life', () => {
    const speed = 400;
    const { world } = handWorld([marcher(2, 0, speed, DEFENSE.boss.hp, true), marcher(0, 900, 50)], { boss: 2 });
    const breach = breachStep(startZ(0, speed), speed, DEFENSE.boss.d);
    expect(health(playFor(world, breach))).toBe(START_LIVES);
    const after = playFor(world, breach + 1);
    expect(health(after)).toBe(0);
    expect(outcomeOf(after)).toBe('lost');
  });

  it('holding a lane for half a second places one guard there, never a second in the same lane', () => {
    const { world, defender } = handWorld([marcher(0, 1500, 50)]);
    expect(defendersIn(playFor(world, DEFENSE.hold, holdIn(3, 0, DEFENSE.hold - 1)), defender)).toEqual([]);
    expect(defendersIn(playFor(world, DEFENSE.hold, holdIn(3, 0, DEFENSE.hold)), defender)).toEqual([3]);
    // Pustit a držet znovu v témže pruhu: obránce zůstane jeden. V jiném pruhu přibude.
    const twice = (lane: number) => (tick: number) => holdIn(3, 0, DEFENSE.hold)(tick) ?? holdIn(lane, DEFENSE.hold + 2, 2 * DEFENSE.hold + 2)(tick);
    expect(defendersIn(playFor(world, 2 * DEFENSE.hold + 4, twice(3)), defender)).toEqual([3]);
    expect(defendersIn(playFor(world, 2 * DEFENSE.hold + 4, twice(1)), defender).sort()).toEqual([1, 3]);
    // Držení déle než půl vteřiny nestaví dál.
    expect(defendersIn(playFor(world, 3 * DEFENSE.hold, holdIn(3, 0, 3 * DEFENSE.hold)), defender)).toEqual([3]);
  });

  it('a guard shoots an enemy in its lane once it is in reach, and the kill counts', () => {
    const { world, arrow } = handWorld([marcher(2, 40, 50), marcher(4, 1200, 50)]);
    const guarded = (tick: number) => holdIn(2, 0, DEFENSE.hold)(tick);
    // Volej v tiku 90 – nepřítel je ještě daleko, obránce nestřílí.
    expect(copiesOf(playFor(world, 91, guarded), arrow)).toHaveLength(0);
    const state = playFor(world, 400, guarded);
    expect(items(state)).toBe(1);
    expect(health(state)).toBe(START_LIVES);
    // Bez obránce týž nepřítel dojde k hradbě.
    expect(health(playFor(world, 400))).toBe(START_LIVES - 1);
  });

  it('wins once every enemy is gone, and the wave counter rises when a wave comes into view', () => {
    const { world } = handWorld([marcher(0, 10, 50), marcher(1, 100, 50)], { waves: [99] });
    expect(waveOf(playFor(world, 99))).toBe(0);
    expect(waveOf(playFor(world, 100))).toBe(1);
    const state = playFor(world, 200, (tick) => tapsAt(0, 20)(tick) ?? tapsAt(1, 110)(tick));
    expect(outcomeOf(state)).toBe('won');
    expect(health(state)).toBe(START_LIVES);
    expect(WAVE_COUNTER).toBe('ammo');
  });
});

describe('defense gates on the live cell (G1, G2, G4, G5, G6)', () => {
  it('G1: the world bot wins on all 20 seeds in 45–90 s', () => {
    for (const seed of SEEDS) {
      const run = runBot(worldOf(seed));
      expect(run.outcome, `seed ${seed}`).toBe('won');
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeGreaterThanOrEqual(45);
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeLessThanOrEqual(90);
    }
  });

  it('G1 at the bounds: the bot also wins the smallest and the largest waves', () => {
    for (const seed of [1, 2, 3]) for (const enemies of [DEFENSE.enemies.min, DEFENSE.enemies.max]) {
      const run = runBot(worldOf(seed, enemies));
      expect(run.outcome, `seed ${seed}, ${enemies} enemies`).toBe('won');
      expect(run.tick / ARCADE_HZ, `seed ${seed}, ${enemies} enemies`).toBeLessThanOrEqual(90);
    }
  });

  it('G2 + G6: an idle player never wins and downs nobody; the bot downs every enemy and keeps every life', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const idle = finalState(world, []);
      expect(outcomeOf(idle), `seed ${seed}`).toBe('lost');
      expect(items(idle), `seed ${seed}: idle downed`).toBe(0);
      // Prohraje na průlomech pěšáků, dávno před bossem – každý průlom bere život.
      expect(idle[HEADER.tick], `seed ${seed}: idle lost only to the boss`).toBeLessThan(DEFENSE.bossAt);
      const bot = finalState(world, runBot(world).inputs);
      expect(items(bot), `seed ${seed}: bot downed`).toBe(DEFAULTS.enemies);
      expect(health(bot), `seed ${seed}: an enemy broke through`).toBe(START_LIVES);
    }
  });

  it('a player who only places five guards and then waits loses', () => {
    const order = [2, 1, 3, 0, 4];
    const build: InputEvent[] = order.flatMap((lane, k) => Array.from({ length: DEFENSE.hold }, (_, t): InputEvent => ({ tick: k * (DEFENSE.hold + 2) + t, buttons: BUTTON.HOLD, axis: axisOfLane(lane) })));
    for (const seed of SEEDS) {
      const state = finalState(worldOf(seed), build);
      expect(outcomeOf(state), `seed ${seed}`).toBe('lost');
      expect(items(state), `seed ${seed}: the guards shot nobody`).toBeGreaterThan(0);
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

  it('G5: lives, combo, the end bonus and a boss finale are in the live world', () => {
    const world = worldOf(3);
    expect(world.initial[HEADER.counters + COUNTER.health]).toBe(START_LIVES);
    const hit = world.rules.find((ref) => ref.id === 'defense_hit');
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
    expect(waveOf(state)).toBe(DEFENSE.waves - 1);
    // Finále P51: hrozba s aspoň třemi zásahy, která padla – telemetrie ho pozná jako bosse.
    expect(funMetrics(traceRun(world, inputs)).finale).toEqual({ present: true, why: 'boss' });
  });

  it('witnesses shoot, defeat, defend and the lanes move in the bot run, and the marching enemy harms in its probe', () => {
    if (spec === null) throw new Error('defense.default is not a live cell');
    const made = arcadeWorldOf(spec, 2);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    const verbs = new Set(verdict.witnesses.map((witness) => witness.verb));
    for (const verb of ['shoot', 'defeat', 'defend', 'lanes', 'chaser']) expect(verbs.has(verb), verb).toBe(true);
    expect(verdict.witnesses.find((witness) => witness.verb === 'defend')?.object?.label).toBe('castle');
    expect(verdict.failures).toEqual([]);
  });
});

/** Bonus události v pruhu `lane`, který vejde do obrazu po kroku `enter − 1`. */
function bonusBody(lane: number, enter: number, mark: number, speed: number = DEFENSE.bonus.speed): BodyInit {
  const { w, h, d } = DEFENSE.bonus;
  return { role: 'collectible', kind: 'bonus', x: laneX(lane), y: 0, z: startZ(enter, speed), w, h, d, solid: false, vz: -speed, kinematic: true, hp: mark };
}

describe('defense lane events (P55 T5)', () => {
  it('a bonus downed by the hero scores without counting; a missed one costs nothing and leaves the view', () => {
    // Nepřítel daleko v pruhu 4 drží hru v běhu; bonus jde pruhem 0.
    const { world } = handWorld([marcher(4, 1500, 50), bonusBody(0, 10, EVENT_MARK.golden)]);
    const shot = playFor(world, 40, tapsAt(0, 20));
    expect(alive(shot, 3)).toBe(false);
    expect(items(shot)).toBe(0);
    expect(score(shot)).toBe(DEFENSE.points * LANE_EVENTS.goldenPoints);
    const { world: series } = handWorld([marcher(4, 1500, 50), bonusBody(0, 10, EVENT_MARK.series), bonusBody(1, 20, EVENT_MARK.series)]);
    expect(defenseInView(playFor(series, 20), 3)).toBe(true);
    const missed = playFor(series, 400);
    expect(health(missed)).toBe(START_LIVES);
    expect(outcomeOf(missed)).toBe('running');
    expect([3, 4].map((body) => defenseInView(missed, body))).toEqual([false, false]);
    // Šíp obránce bonus míjí: obránce v pruhu 0 sestřelí nepřítele za pomalým bonusem a bonus jde dál.
    const { world: behind } = handWorld([marcher(4, 1500, 50), bonusBody(0, 10, EVENT_MARK.series, 40), marcher(0, 60, 50)]);
    const guarded = playFor(behind, 330, holdIn(0, 0, DEFENSE.hold));
    expect(alive(guarded, 4)).toBe(false);
    expect(alive(guarded, 3)).toBe(true);
    expect(score(guarded)).toBe(DEFENSE.points);
  });

  it('every game has a rush and a bonus within 10 s, every kind shows up, and no bonus shares a lane window', () => {
    const seen = new Set<number>();
    for (const seed of SEEDS) {
      const bonuses = bonusesOf(defenseLevel(seed, DEFAULTS));
      for (const bonus of bonuses) seen.add(bonus.mark);
      expect(bonuses.some((bonus) => bonus.mark === EVENT_MARK.rush), `seed ${seed}`).toBe(true);
      expect(bonuses[0]!.enter, `seed ${seed}`).toBeLessThanOrEqual(600);
      // Bonusy jdou z vlastního streamu: nepřátelé jdou s nimi i bez nich stejně.
      expect(marchOf(defenseLevel(seed, DEFAULTS))).toEqual(marchOf({ ...defenseLevel(seed, DEFAULTS), bodies: defenseLevel(seed, DEFAULTS).bodies.filter((body) => body.role !== 'collectible') }));
      expect(defenseBonuses(seed, defenseMarch(seed, DEFAULTS))).toEqual(bonuses);
    }
    expect(seen).toEqual(new Set(Object.values(EVENT_MARK)));
    // Bonus v okně nepřítele téhož pruhu kontrola odmítne.
    const level = defenseLevel(1, DEFAULTS);
    const first = marchOf(level)[0]!;
    const crowded = { ...level, bodies: [...level.bodies.slice(0, 2), bonusBody(first.lane, first.enter + 5, EVENT_MARK.series), ...level.bodies.slice(2)] };
    expect(checkDefenseLevel(crowded, DEFAULTS).join(' ')).toMatch(/shares lane/);
  });

  it('seed 1: lively from start to finish and still a 30–90 s win (baseline 2.76 events/s, gap 8.28 s)', () => {
    const world = worldOf(1);
    const bot = runBot(world, undefined, { profile: 'intermediate' });
    const trace = traceRun(world, bot.inputs);
    const fun = funMetrics(trace);
    expect(fun.eventsPerS).toBeGreaterThanOrEqual(4.14);
    expect(fun.longestGapS).toBeLessThanOrEqual(3);
    expect(trace.events.find((event) => event.kind === 'pickup')!.tick).toBeLessThanOrEqual(10 * ARCADE_HZ);
    const own = runBot(world);
    expect(own.outcome).toBe('won');
    expect(own.tick / ARCADE_HZ).toBeGreaterThanOrEqual(30);
    expect(own.tick / ARCADE_HZ).toBeLessThanOrEqual(90);
    expect(traceRun(worldOf(1), bot.inputs).hash).toBe(trace.hash);
  });
});

describe('defense difficulty band (G3 on 20 seeds; the gate itself is difficulty.test.ts)', () => {
  const rate = (profile: BotProfile): number => SEEDS.filter((seed) => runBot(worldOf(seed), undefined, { profile }).outcome === 'won').length / SEEDS.length;
  it('novice wins 0.3–0.7, intermediate at least 0.8', () => {
    expect(Object.keys(BOT_PROFILES)).toEqual(['novice', 'intermediate']);
    const novice = rate('novice');
    const intermediate = rate('intermediate');
    expect(novice, `novice ${novice}`).toBeGreaterThanOrEqual(0.3);
    expect(novice, `novice ${novice}`).toBeLessThanOrEqual(0.7);
    expect(intermediate, `intermediate ${intermediate}`).toBeGreaterThanOrEqual(0.8);
  });

  it('the bot piece is registered, reacts like the check assumes, and never sees into the fog', () => {
    expect(ARCADE_LIBRARY.bots.defense_bot).toBe(defenseBot);
    expect(defenseBot.reactionTicks).toBe(8);
    const { world, bolt, arrow, defender } = handWorld([marcher(0, 30, 400)]);
    // V tiku 29 je nepřítel ještě v mlze: robot o něm neví, i když ve 30 vyjde.
    const view = (tick: number) => defenseView({ state: playFor(world, tick), player: 0, tick, recent: [] }, { bolt, arrow, defender });
    expect(view(29).threats).toEqual([]);
    expect(view(30).threats.map((threat) => threat.body)).toEqual([2]);
    expect(view(30).threats[0]!.breach - 30).toBeLessThan(DEFENSE_CALM);
  });
});
