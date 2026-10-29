/**
 * Přežití ve vlnách (P66 T5): pohyb joystickem, střelba sama, mezi vlnami výběr 1 ze 3 vylepšení, na konci boss.
 *
 * Hlídá společné AC žánrů P66 (T5–T9): robot vyhraje, nečinný hráč prohraje, slabý robot (práh chyb) prohraje, dvě
 * přehrání téhož záznamu = týž hash a publikační brána (`verifyArcade`) projde na 10 semínkách, hra 30–90 s. Navíc
 * **pin T5**: vylepšení musí na bossovi rozhodovat – robot bez nich (tentýž svět, nabídky odebrané) na bossovi prohraje.
 * Survivor, kde robot vyhraje i bez vylepšení, by vypadal zábavně a výběr by nic neznamenal.
 *
 * Dál: háčky v běhu robota (kola, nabídky, volba rány napřed, boss, vzácnost, hlášky komba – pravidlo nového žánru
 * s parametrem `combo` je od `genre.v6` zdrojem komba), příchody od okrajů i shora a zdola, ruční spec e2e = překlad
 * modulu a meze parametrů.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { compileWith } from '../../compose/compile';
import type { GenreModule } from '../../genre/contract';
import { readGenreSpec } from '../../genre/index';
import { survivorGenre } from '../../genre/survivor';
import { type GameSpecV1, readGameSpec } from '../../spec';
import { arcadeWorldOf, compileArcade } from '../compile';
import { type ArcadeEffect, type ArcadeWorld, HEADER, type InputEvent, NO_INPUT, type PieceRef } from '../contract';
import { type HookEffect, UPGRADE_OFFER, isHookEffect } from '../hooks/contract';
import { type HookParams, foundOf, hooksOf, roundOf, upgradeLevel } from '../hooks';
import { instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { blunders, survivorBot, survivorPick } from '../pieces/survivor-bot';
import { BOSS, SURVIVOR, SURVIVOR_BODIES, SURVIVOR_UPGRADES, bossHpOf, survivorControl, survivorWaves, wavedEnemies, waveSizes } from '../pieces/survivor';
import { runBot, verifyArcade } from '../verify';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);
const module = survivorGenre as unknown as GenreModule;
/** Obsah ruční hry e2e (`e2e/fixtures/p66-survivor-spec.json`): rytíř proti zombiím v rozbitém městě. */
const CONTENT = { genre: 'survivor', mode: 'default', hero: 'knight', setting: 'ruined town', cast: [{ label: 'zombie', does: 'shoot_at' }] } as const;

function specOf(content: object = CONTENT): GameSpecV1 {
  const read = readGenreSpec(content);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileWith(module, read.value);
}

const SPEC = specOf();

function worldOf(seed: number, spec: GameSpecV1 = SPEC): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Tentýž svět bez nabídek vylepšení: přestávky jsou jen odpočet, robot nic nevybere. */
function withoutUpgrades(world: ArcadeWorld): ArcadeWorld {
  return {
    ...world,
    rules: world.rules.map((ref): PieceRef => {
      if (ref.id !== 'hooks') return ref;
      const { upgrades: _upgrades, ...rest } = ref.params as HookParams;
      return { id: 'hooks', params: rest };
    }),
  };
}

/** Slabý robot: týž robot s prahem chyb 500 ‰ (stojí v každém druhém okně). */
const weakened = (world: ArcadeWorld): ArcadeWorld => ({ ...world, bot: { id: 'survivor_bot', params: { ...world.bot.params, errors: 500 } } });

interface Played {
  readonly outcome: string;
  readonly tick: number;
  readonly round: number;
  readonly state: Int32Array;
  readonly events: readonly (HookEffect & { readonly tick: number })[];
  readonly effects: readonly (readonly ArcadeEffect[])[];
}

/** Přehraje záznam jako `replay` a zapamatuje si efekty a zprávy háčků. */
function play(world: ArcadeWorld, inputs: readonly InputEvent[]): Played {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const events: (HookEffect & { tick: number })[] = [];
  const effects: (readonly ArcadeEffect[])[] = [];
  let next = 0;
  for (let tick = 0; tick < 5400 && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    const out = step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    effects.push(out);
    for (const effect of out) if (isHookEffect(effect)) events.push({ ...effect, tick });
  }
  return { outcome: outcomeOf(state), tick: state[HEADER.tick] as number, round: roundOf(state, hooksOf(world.rules)!.keeper), state, events, effects };
}

const ofKind = <K extends HookEffect['kind']>(played: Played, kind: K) => played.events.filter((event): event is Extract<HookEffect, { kind: K }> & { tick: number } => event.kind === kind);

describe('survivor world (P66 T5)', () => {
  it('the e2e fixture is exactly what the genre module compiles, and a GameSpec reads it', () => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'e2e/fixtures/p66-survivor-spec.json'), 'utf8')) as unknown;
    expect(fixture).toEqual(JSON.parse(JSON.stringify(SPEC)));
    const read = readGameSpec(fixture);
    expect(read.ok, read.ok ? '' : read.issues.join('; ')).toBe(true);
    expect(SPEC.genre).toEqual({ id: 'survivor', mode: 'default', compilerVersion: 'genre.v6' });
    expect(SPEC.control).toBe('survivor');
    // Pro výběr kostra (`staged`) a bez narážek, dokud T12 nepřesune buňku receptu – hraje z ručního specu (jako šipky).
    expect(module.availability('default' as never)).toBe('staged');
    expect(module.cues).toEqual([]);
  });

  it('builds a portrait arena with its own control, rules, hooks (rounds, upgrades, rarity, boss) and a kill combo', () => {
    const world = worldOf(1);
    expect(world.control.id).toBe('survivor');
    expect(ARCADE_LIBRARY.controls.survivor).toBe(survivorControl);
    expect(ARCADE_LIBRARY.bots.survivor_bot).toBe(survivorBot);
    expect(world.bot.id).toBe('survivor_bot');
    // Aréna je na výšku vyšší než širší.
    expect(SURVIVOR.halfZ).toBeGreaterThan(SURVIVOR.halfX);
    expect(world.rules.map((ref) => ref.id)).toEqual(['survivor_fire', 'survivor_hit', 'survivor_touch', 'pickup', 'survivor_round', 'out_of_health', 'hooks', 'score_bonus']);
    const hooks = hooksOf(world.rules)!;
    expect(hooks.rounds).toBe(SURVIVOR.rounds.default);
    expect(hooks.clear).toBe('win');
    expect(hooks.boss).toBe(SURVIVOR_BODIES.boss);
    expect(hooks.rarity?.draws).toMatch(/^[012]+$/);
    expect(hooks.upgrades?.offers).toHaveLength(SURVIVOR.rounds.default - 1);
    for (const order of hooks.upgrades!.offers) expect([...order].sort()).toEqual([...SURVIVOR_UPGRADES].sort());
    // Kombo nového žánru (genre.v6): pravidlo s parametrem `combo` je zdrojem komba – dostalo počítadlo komba.
    const hit = world.rules.find((ref) => ref.id === 'survivor_hit')!;
    expect(typeof hit.params.combo).toBe('number');
    expect(hooks.combo).toBe(hit.params.combo);
    expect(world.rules.find((ref) => ref.id === 'pickup')!.params.combo).toBe(hit.params.combo);
  });

  it('is deterministic: the same seed builds the same world, another seed another wave schedule', () => {
    expect(canonicalHash(worldOf(3))).toBe(canonicalHash(worldOf(3)));
    const schedule = (seed: number) => JSON.stringify(worldOf(seed).rules.find((ref) => ref.id === 'survivor_round')!.params.waves);
    expect(schedule(3)).not.toBe(schedule(4));
  });
});

describe('survivor publication gate on 10 seeds (P66 T5)', () => {
  const runs = SEEDS.map((seed) => {
    const world = worldOf(seed);
    return { seed, world, compiled: compileArcade(SPEC, seed), verdict: verifyArcade(world) };
  });

  it('the bot wins every seed in 30–90 s, the idle player loses, two replays of the record match, the gate passes', () => {
    for (const { seed, world, compiled, verdict } of runs) {
      expect(compiled.ok, `seed ${String(seed)}: ${compiled.ok ? '' : compiled.issues.join('; ')}`).toBe(true);
      expect(verdict.failures, `seed ${String(seed)}`).toEqual([]);
      expect(verdict.publishEligible).toBe(true);
      expect(verdict.bot.outcome).toBe('won');
      expect(verdict.bot.tick / 60, `seed ${String(seed)} seconds`).toBeGreaterThanOrEqual(30);
      expect(verdict.bot.tick / 60, `seed ${String(seed)} seconds`).toBeLessThanOrEqual(90);
      expect(verdict.idle.outcome).toBe('lost');
      expect(verdict.replayEqual).toBe(true);
      expect(replay(world, verdict.bot.inputs, ARCADE_LIBRARY).hash).toBe(replay(world, verdict.bot.inputs, ARCADE_LIBRARY).hash);
    }
  });

  it('a weak bot (error threshold 500 ‰) loses on at least 8 of 10 seeds – the game can be lost', () => {
    const lost = SEEDS.filter((seed) => runBot(weakened(worldOf(seed))).outcome !== 'won');
    expect(lost.length, `weak bot lost on ${lost.join(', ')}`).toBeGreaterThanOrEqual(8);
  });

  it('pin: upgrades decide the boss – with picks the bot wins 10/10, without them it loses on the boss on at least 7/10', () => {
    const outcomes = SEEDS.map((seed) => {
      const world = worldOf(seed);
      const bare = withoutUpgrades(world);
      const plain = runBot(bare);
      return { seed, upgraded: runBot(world).outcome, plain: plain.outcome, round: play(bare, plain.inputs).round };
    });
    expect(outcomes.filter((row) => row.upgraded === 'won')).toHaveLength(SEEDS.length);
    const lost = outcomes.filter((row) => row.plain !== 'won');
    expect(lost.length, JSON.stringify(outcomes)).toBeGreaterThanOrEqual(7);
    // Bez vylepšení se vlny přežít dají: prohra přijde až na bossovi (poslední kolo).
    for (const row of lost) expect(row.round, `seed ${String(row.seed)}`).toBe(SURVIVOR.rounds.default - 1);
  });
});

describe('survivor hooks in a bot run (P66 T5)', () => {
  const world = worldOf(1);
  const bot = runBot(world);
  const played = play(world, bot.inputs);
  const keeper = hooksOf(world.rules)!.keeper;

  it('plays four rounds with three offers, picks a damage card first, and the boss enters once in the last round', () => {
    expect(played.outcome).toBe('won');
    expect(ofKind(played, 'round_start').map((event) => event.round)).toEqual([0, 1, 2, 3]);
    expect(ofKind(played, 'round_clear').map((event) => event.round)).toEqual([0, 1, 2, 3]);
    const offers = ofKind(played, 'upgrade_offer');
    const picks = ofKind(played, 'upgrade_pick');
    expect(offers).toHaveLength(3);
    expect(picks).toHaveLength(3);
    const taken = new Map<string, number>();
    picks.forEach((pick, k) => {
      const offer = offers[k]!.offer;
      // Robot přežití: rána napřed, dostřel jen první stupeň (`SURVIVOR_PICK_PRIORITY`), podle stupňů v tu chvíli.
      expect(pick.card).toBe(survivorPick(offer, (id) => taken.get(id) ?? 0));
      taken.set(pick.upgrade, (taken.get(pick.upgrade) ?? 0) + 1);
      // Robot vybere hned (reakce + 1 tik), ne až výchozí kartu po `pickTicks`.
      expect(pick.tick - offers[k]!.tick).toBeLessThan(UPGRADE_OFFER.pickTicks);
    });
    const levels = SURVIVOR_UPGRADES.reduce((sum, id) => sum + upgradeLevel(played.state, keeper, id), 0);
    expect(levels).toBe(3);
    const boss = ofKind(played, 'boss_enter');
    expect(boss).toHaveLength(1);
    expect(boss[0]!.tick).toBeGreaterThan(ofKind(played, 'round_start')[3]!.tick);
    expect(played.events.some((event) => event.kind === 'callout' && event.callout === 'boss')).toBe(true);
  });

  it('crystals from the fallen carry rarity, kills chain into a combo, and every kill pops a score', () => {
    const found = foundOf(played.state, keeper);
    expect(found.common + found.rare + found.epic).toBeGreaterThan(0);
    expect(played.events.some((event) => event.kind === 'callout' && event.callout === 'combo_2')).toBe(true);
    expect(ofKind(played, 'score_pop').length).toBeGreaterThan(20);
  });

  it('enemies come from every side of the portrait arena, the top and the bottom too', () => {
    const arrivals = played.effects.flat().filter((effect): effect is Extract<ArcadeEffect, { kind: 'spawn' }> => effect.kind === 'spawn' && effect.template >= SURVIVOR_BODIES.minion);
    expect(arrivals.length).toBeGreaterThan(30);
    expect(arrivals.some((effect) => effect.z > SURVIVOR.halfZ / 2)).toBe(true);
    expect(arrivals.some((effect) => effect.z < -SURVIVOR.halfZ / 2)).toBe(true);
    expect(arrivals.some((effect) => Math.abs(effect.x) > SURVIVOR.halfX / 2)).toBe(true);
    for (const effect of arrivals) {
      expect(Math.abs(effect.x)).toBeLessThanOrEqual(SURVIVOR.halfX);
      expect(Math.abs(effect.z)).toBeLessThanOrEqual(SURVIVOR.halfZ);
    }
  });

  it('the boss attacks: a telegraph of at least 400 ms before each attack, and a volley of orbs', () => {
    expect(BOSS.telegraph).toBeGreaterThanOrEqual(24);
    expect(BOSS.enragedTelegraph).toBeGreaterThanOrEqual(24);
    const orbs = played.effects.flat().filter((effect) => effect.kind === 'spawn' && effect.template === SURVIVOR_BODIES.orb);
    expect(orbs.length).toBeGreaterThanOrEqual(BOSS.volley.count);
  });

  it('an idle player gets the default card when the offer runs out', () => {
    const idle = play(world, []);
    expect(idle.outcome).toBe('lost');
    const picks = ofKind(idle, 'upgrade_pick');
    const offers = ofKind(idle, 'upgrade_offer');
    expect(picks.length).toBe(offers.length);
    for (const [k, pick] of picks.entries()) {
      expect(pick.card).toBe(UPGRADE_OFFER.defaultCard);
      expect(pick.tick - offers[k]!.tick).toBe(UPGRADE_OFFER.pickTicks);
    }
  });
});

describe('survivor genre module and bounds (P66 T5)', () => {
  it('at the bounds (rounds 2, 3, 5 × enemies 16, 40) the bot wins at least 9 of 10 seeds and the idle player never', () => {
    // Semínko, na kterém robot prohraje, publikace přeskočí (`UNWINNABLE`, další semínko); výchozí hra vyhraje všech 10 (výš).
    for (const rounds of [SURVIVOR.rounds.min, 3, SURVIVOR.rounds.max]) {
      for (const enemies of [SURVIVOR.enemies.min, SURVIVOR.enemies.max]) {
        const spec = specOf({ ...CONTENT, params: { rounds, enemies } });
        const worlds = SEEDS.map((seed) => worldOf(seed, spec));
        const won = worlds.filter((world) => runBot(world).outcome === 'won').length;
        expect(won, `rounds ${String(rounds)}, enemies ${String(enemies)}`).toBeGreaterThanOrEqual(9);
        for (const world of worlds) expect(replay(world, [], ARCADE_LIBRARY).outcome).toBe('lost');
      }
    }
  });

  it('reads params only inside the bounds, sizes waves that fit and scales the boss with the picks', () => {
    expect(readGenreSpec({ ...CONTENT, params: { rounds: 6 } }).ok).toBe(false);
    expect(readGenreSpec({ ...CONTENT, params: { enemies: SURVIVOR.enemies.max + 1 } }).ok).toBe(false);
    expect(waveSizes(36, 3)).toEqual([8, 12, 16]);
    expect(wavedEnemies(SURVIVOR.enemies.max, 3)).toBeLessThan(SURVIVOR.enemies.max);
    expect(bossHpOf(2)).toBeLessThan(bossHpOf(3));
    expect(bossHpOf(4)).toBeGreaterThan(bossHpOf(3));
    expect(survivorWaves.params.safeParse({}).success).toBe(true);
    // Text cíle počítá nepřátele, kteří opravdu přijdou.
    const many = specOf({ ...CONTENT, params: { rounds: 3, enemies: SURVIVOR.enemies.max } });
    expect(many.objective.count).toBe(wavedEnemies(SURVIVOR.enemies.max, 3));
  });

  it('draft fill takes the enemy and the named ammunition from the sentence', () => {
    const fill = module.draftFill('a wizard fights zombies and shoots fireballs in a graveyard', null) as { cast?: readonly { label: string; does: string; verb?: string }[] };
    expect(fill.cast?.some((item) => item.does === 'shoot_at')).toBe(true);
    expect(fill.cast?.some((item) => item.does === 'scenery' && item.verb === 'shoot' && item.label === 'fireball')).toBe(true);
    const spec = specOf({ ...CONTENT, cast: [...CONTENT.cast, { label: 'fireball', does: 'scenery', verb: 'shoot' }], boss: { role: 'zombie king', name: 'Zombie King', attack: 'stomp' } });
    expect(spec.roles.map((role) => role.id)).toEqual(['player', 'enemy', 'boss', 'drop', 'ammunition']);
    expect((spec.controlParams as { tuning?: { attack?: string } }).tuning?.attack).toBe('stomp');
    expect(runBot(worldOf(1, spec)).outcome).toBe('won');
  });

  it('the weak bot stands still in a fixed share of windows, the world bot never', () => {
    const windows = Array.from({ length: 200 }, (_, k) => blunders(k * 30, 500));
    expect(windows.filter(Boolean).length).toBeGreaterThan(70);
    expect(windows.filter(Boolean).length).toBeLessThan(130);
    expect(Array.from({ length: 200 }, (_, k) => blunders(k * 30, 0)).some(Boolean)).toBe(false);
    expect(blunders(1234, 500)).toBe(blunders(1234, 500));
  });
});
