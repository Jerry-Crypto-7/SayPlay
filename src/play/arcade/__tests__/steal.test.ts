/**
 * Krádež (P66 T7): hrdina doběhne k cizí základně, popadne kořist z věty, s nákladem pomaleji ji odnese domů; strážci
 * zloděje honí a při dotyku kořist vezmou zpět. Kola s výběrem vylepšení, vzácnost kořisti, poslední kolo s velkou
 * kořistí a silnějším strážcem.
 *
 * **Pin (Test level):** strážce, který hrdinu nikdy nedohoní, udělá z krádeže procházku – robot by vyhrál i bez
 * jediného úhybu. Test proto drží, že slabý robot (stejný robot, jen strážce nevidí, `wary` 0) prohraje na všech
 * semínkách, zatímco robot, který čeká na bezpečné sebrání, vyhraje. K tomu brány žánru (robot vyhraje za 30–90 s,
 * nečinný prohraje, přehrání = týž hash, publikační brána projde na 10 semínkách) a pravidla, která o výsledku
 * rozhodují bez dozoru.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GenreModule } from '../../genre/contract';
import { compileWith, readGenreSpec } from '../../genre/index';
import { stealGenre } from '../../genre/steal';
import { type GameSpecV1, readGameSpec } from '../../spec';
import { arcadeWorldOf, compileArcade } from '../compile';
import { ARCADE_HZ, type ArcadeEffect, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, type InputEvent, NO_INPUT, ROLE, bodyBase, graceOf, nativeRule, setTargetState } from '../contract';
import { foundOf, hooksOf, rarityOf, upgradeLevel } from '../hooks';
import { HOOK_SLOTS, LEVEL_BITS, UPGRADES } from '../hooks/contract';
import { instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { arenaAxis } from '../pieces/arena';
import { LOOT, STEAL, STEAL_UPGRADES, type StealControlParams, capacityOf, chasing, guardsOf, heroSpeedOf, lootIn, roundTicksOf } from '../pieces/steal';
import { patrolAt } from '../pieces/steal-bot';
import { runBot, verifyArcade } from '../verify';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);

function specOf(params: Record<string, number> = {}): GameSpecV1 {
  const spec = stealGenre.compile({ genre: 'steal', mode: 'default', hero: 'fox', setting: 'forest', params, cast: [{ label: 'gem', does: 'collect' }, { label: 'robot', does: 'chase_me' }] });
  const read = readGameSpec(spec);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
}

const SPEC = specOf();
const worlds = new Map<number, ArcadeWorld>();
function worldOf(seed: number): ArcadeWorld {
  const known = worlds.get(seed);
  if (known !== undefined) return known;
  const made = arcadeWorldOf(SPEC, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  worlds.set(seed, made.world);
  return made.world;
}
const runs = new Map<number, ReturnType<typeof runBot>>();
function botRun(seed: number): ReturnType<typeof runBot> {
  const run = runs.get(seed) ?? runBot(worldOf(seed));
  runs.set(seed, run);
  return run;
}

/** Tentýž svět se slabým robotem: stejný robot krádeže pod obalem háčků, jen strážce nevidí (`wary` 0). */
function careless(world: ArcadeWorld): ArcadeWorld {
  const wrapped = world.bot.params as { base: { id: string; params: Record<string, unknown> }; keeper: number };
  return { ...world, bot: { ...world.bot, params: { ...wrapped, base: { ...wrapped.base, params: { ...wrapped.base.params, wary: 0 } } } } };
}

const paramsOf = (world: ArcadeWorld): StealControlParams => world.control.params as StealControlParams;
const keeperOf = (world: ArcadeWorld): number => hooksOf(world.rules)!.keeper;
const counter = (state: Int32Array, name: keyof typeof COUNTER): number => state[HEADER.counters + COUNTER[name]] as number;
const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/**
 * Přehraje záznam a vrátí konečný stav, efekty po ticích a stav po prvním tiku každého kola (kolo postaví ovládání
 * až v tiku po `round_start`).
 */
function play(world: ArcadeWorld, inputs: readonly InputEvent[], horizon = 5400): { readonly state: Int32Array; readonly effects: (readonly ArcadeEffect[])[]; readonly starts: Int32Array[] } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const effects: (readonly ArcadeEffect[])[] = [];
  const starts: Int32Array[] = [];
  let next = 0;
  let started = false;
  for (let tick = 0; tick < horizon && state[HEADER.runState] === 0; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    const out = step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    effects.push(out);
    if (started) starts.push(state.slice());
    started = out.some((effect) => effect.kind === 'round_start') && tick > 0;
  }
  return { state, effects, starts };
}

describe('steal genre gates (P66 T7)', () => {
  it('the bot wins every seed in 30–90 s; a player who does nothing loses on the round clock', () => {
    for (const seed of SEEDS) {
      const run = botRun(seed);
      expect(run.outcome, `seed ${seed}`).toBe('won');
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeGreaterThanOrEqual(30);
      expect(run.tick / ARCADE_HZ, `seed ${seed}`).toBeLessThanOrEqual(90);
      const idle = replay(worldOf(seed), [], ARCADE_LIBRARY);
      expect(idle.outcome, `seed ${seed}`).toBe('lost');
      expect(idle.tick, `seed ${seed}: the first round's clock ends the idle game`).toBe(roundTicksOf(STEAL.rounds.default) + 1);
    }
  });

  it('pin: a careless thief who never minds the guards loses on every seed (guards that never catch would make it a walk)', () => {
    for (const seed of SEEDS) {
      const run = runBot(careless(worldOf(seed)));
      expect(run.outcome, `seed ${seed}`).toBe('lost');
      const end = play(worldOf(seed), run.inputs).state;
      // Prohrál chycením (životy), ne hodinami kola: strážci ho opravdu dohonili.
      expect(counter(end, 'health'), `seed ${seed}`).toBe(0);
    }
  });

  it('two replays of the bot record end in the same hash, and the publication gate passes on 10 seeds', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const run = botRun(seed);
      const first = replay(world, run.inputs, ARCADE_LIBRARY);
      const second = replay(world, run.inputs, ARCADE_LIBRARY);
      expect(first.hash).toBe(second.hash);
      expect(first.hash).toBe(run.hash);
      const verdict = verifyArcade(world);
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      expect(verdict.publishEligible).toBe(true);
      expect(compileArcade(SPEC, seed).ok, `seed ${seed}`).toBe(true);
    }
  });

  it('every parameter combination inside the module bounds is winnable by the bot and lost by an idle player', () => {
    const combos: readonly Record<string, number>[] = [{ rounds: 2 }, { rounds: 4, loot: 2 }, { loot: 4 }, { guards: 2 }, { guards: 3 }, { rounds: 4, guards: 2 }];
    for (const params of combos) {
      const spec = specOf(params);
      for (const seed of [1, 2, 3]) {
        const made = arcadeWorldOf(spec, seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        expect(runBot(made.world).outcome, `${JSON.stringify(params)} seed ${seed}`).toBe('won');
        expect(replay(made.world, [], ARCADE_LIBRARY).outcome).toBe('lost');
      }
    }
  });
});

describe('steal rules (P66 T7)', () => {
  it('carrying slows the hero; each carry level carries one more and slows less', () => {
    const world = worldOf(1);
    const hooks = keeperOf(world);
    const state = instantiate(world);
    expect(heroSpeedOf(state, hooks, false)).toBe(STEAL.speed);
    expect(heroSpeedOf(state, hooks, true)).toBeLessThan(STEAL.speed);
    expect(capacityOf(state, hooks)).toBe(1);
    // Jeden stupeň `carry` ve stavu háčků.
    state[bodyBase(hooks) + HOOK_SLOTS.levels] = 1 << (UPGRADES.indexOf('carry') * LEVEL_BITS);
    expect(upgradeLevel(state, hooks, 'carry')).toBe(1);
    expect(capacityOf(state, hooks)).toBe(2);
    expect(heroSpeedOf(state, hooks, true)).toBeGreaterThan(heroSpeedOf(instantiate(world), hooks, true));

    // V jádře: hrdina, který nese kořist, jede nahoru nejvýš rychlostí s nákladem; bez ní plnou (oba mimo domov,
    // doma by kořist hned odevzdal).
    const program = loadProgram(world, ARCADE_LIBRARY);
    const free = instantiate(world);
    const loaded = instantiate(world);
    for (const at of [free, loaded]) at[bodyBase(0) + BODY.z] = -3000;
    const first = paramsOf(world).loot.first;
    setTargetState(loaded, first, LOOT.carried);
    const up = { buttons: 0, axis: arenaAxis(0, 1) };
    for (let tick = 0; tick < 30; tick += 1) {
      step(free, up, program);
      step(loaded, up, program);
    }
    expect(free[bodyBase(0) + BODY.vz]).toBe(STEAL.speed);
    expect(loaded[bodyBase(0) + BODY.vz]).toBe(heroSpeedOf(loaded, hooks, true));
    expect(loaded[bodyBase(0) + BODY.z]).toBeLessThan(free[bodyBase(0) + BODY.z] as number);
  });

  it('a guard who touches the thief takes the loot back to its spot, costs a life and sends the hero home', () => {
    const world = worldOf(1);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const params = paramsOf(world);
    const state = instantiate(world);
    const loot = params.loot.first;
    const guard = params.guards.first;
    const [spotX, spotZ] = params.loot.spots[0]!;
    setTargetState(state, loot, LOOT.carried);
    // Hrdina uprostřed hřiště, strážce na něm.
    const hero = bodyBase(0);
    state[hero + BODY.z] = 0;
    state[bodyBase(guard) + BODY.x] = state[hero + BODY.x] as number;
    state[bodyBase(guard) + BODY.z] = 0;
    const lives = counter(state, 'health');
    const out = step(state, NO_INPUT, program);
    expect(out).toContainEqual({ kind: 'damage', amount: 1, grace: STEAL.grace });
    expect(counter(state, 'health')).toBe(lives - 1);
    expect(state[hero + BODY.z]).toBe(STEAL.start);
    expect(lootIn(state, LOOT.carried)).toEqual([]);
    step(state, NO_INPUT, program);
    expect(lootIn(state, LOOT.free)).toContain(loot);
    expect([state[bodyBase(loot) + BODY.x], state[bodyBase(loot) + BODY.z]]).toEqual([spotX, spotZ]);
    expect(graceOf(state, 0)).toBeGreaterThan(0);
  });

  it('guards chase only a thief with loot, and a careless one gets caught before home', () => {
    const run = botRun(1);
    const { effects } = play(worldOf(1), run.inputs);
    // Robot sebral i odevzdal: dvojice `score` + `despawn` kořisti.
    expect(effects.flat().filter((effect) => effect.kind === 'despawn').length).toBeGreaterThanOrEqual(STEAL.perRound.default * STEAL.rounds.default);
    const world = worldOf(1);
    const state = instantiate(world);
    const program = loadProgram(world, ARCADE_LIBRARY);
    // Bez kořisti strážce hlídá dál, i když hrdina stojí vedle něj (ale ne na něm).
    const guard = paramsOf(world).guards.first;
    state[bodyBase(0) + BODY.x] = (state[bodyBase(guard) + BODY.x] as number) - 1500;
    state[bodyBase(0) + BODY.z] = state[bodyBase(guard) + BODY.z] as number;
    step(state, NO_INPUT, program);
    expect(chasing(state, guard)).toBe(false);
    setTargetState(state, paramsOf(world).loot.first, LOOT.carried);
    step(state, NO_INPUT, program);
    expect(chasing(state, guard)).toBe(true);
  });

  it('each round adds a guard; the last round brings the big loot (always epic) and a stronger guard who enters as the boss', () => {
    const world = worldOf(1);
    const params = paramsOf(world);
    const run = botRun(1);
    const { starts, effects, state } = play(world, run.inputs);
    const counts = [instantiate(world), ...starts].map((at) => guardsOf(at).length);
    expect(counts).toEqual([1, 2, 3]);
    const last = starts.at(-1)!;
    const boss = params.guards.first + params.guards.posts.length - 1;
    expect(alive(last, boss)).toBe(true);
    expect(last[bodyBase(boss) + BODY.w]).toBe(STEAL.boss.w);
    const big = params.loot.first + (STEAL.rounds.default - 1) * params.loot.per;
    expect(last[bodyBase(big) + BODY.w]).toBe(STEAL.big.w);
    expect(rarityOf(last, big)).toBe('epic');
    const all = effects.flat();
    expect(all.filter((effect) => effect.kind === 'boss_enter')).toEqual([{ kind: 'boss_enter', body: boss }]);
    expect(all.filter((effect) => effect.kind === 'round_clear')).toHaveLength(STEAL.rounds.default);
    // Nálezy podle vzácnosti: každá odevzdaná kořist, aspoň jedna epická (velká).
    const found = foundOf(state, keeperOf(world));
    expect(found.common + found.rare + found.epic).toBe(STEAL.perRound.default * STEAL.rounds.default);
    expect(found.epic).toBeGreaterThanOrEqual(1);
  });

  it('the upgrade offers come from speed, carry, extra_life and magnet, two breaks for three rounds', () => {
    const run = botRun(2);
    const offers = play(worldOf(2), run.inputs).effects.flat().filter((effect): effect is Extract<ArcadeEffect, { kind: 'upgrade_offer' }> => effect.kind === 'upgrade_offer');
    expect(offers).toHaveLength(STEAL.rounds.default - 1);
    for (const offer of offers) for (const card of offer.offer) expect(STEAL_UPGRADES).toContain(card);
  });

  it('genre.v6: the delivery rule is a combo source – delivering raises the combo multiplier', () => {
    const world = worldOf(3);
    const home = nativeRule(world.rules, 'steal_home');
    expect(typeof home?.params.combo).toBe('number');
    const combos = play(world, botRun(3).inputs).effects.flat().filter((effect) => effect.kind === 'combo' && effect.body === home!.params.combo);
    expect(combos.length).toBeGreaterThanOrEqual(STEAL.perRound.default * STEAL.rounds.default);
    // Dvě kořisti odevzdané naráz (náklad 2) zvednou násobič o dva stupně v jednom tiku.
    const state = instantiate(world);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const hooks = keeperOf(world);
    state[bodyBase(hooks) + HOOK_SLOTS.levels] = 1 << (UPGRADES.indexOf('carry') * LEVEL_BITS);
    const params = paramsOf(world);
    setTargetState(state, params.loot.first, LOOT.carried);
    setTargetState(state, params.loot.first + 1, LOOT.carried);
    const out = step(state, NO_INPUT, program);
    expect(out.filter((effect) => effect.kind === 'combo').map((effect) => (effect as { multiplier: number }).multiplier)).toEqual([1, 2]);
    expect(counter(state, 'items')).toBe(2);
  });

  it('the patrol forecast the bot uses matches the guards on their rows over a decision horizon', () => {
    const world = worldOf(4);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    for (let tick = 0; tick < 20; tick += 1) step(state, NO_INPUT, program);
    const guard = paramsOf(world).guards.first;
    const reach = Math.min(STEAL.guard.range, STEAL.half - Math.ceil(STEAL.guard.w / 2));
    // Obrat hlídky trvá rozjezdem (`accel`) pár tiků a strážce při něm přejede konec hlídky, předpověď ho bere jako
    // okamžitý: odchylka nejvýš dráha jednoho obratu tam a zpět (bezpečná vzdálenost robota ji má v rezervě).
    const turn = 2 * (STEAL.guard.patrol * Math.ceil((2 * STEAL.guard.patrol) / STEAL.guard.accel)) + STEAL.guard.patrol;
    for (let round = 0; round < 8; round += 1) {
      const x = state[bodyBase(guard) + BODY.x] as number;
      const vx = state[bodyBase(guard) + BODY.vx] as number;
      for (let tick = 0; tick < 60; tick += 1) step(state, NO_INPUT, program);
      expect(Math.abs((state[bodyBase(guard) + BODY.x] as number) - patrolAt(x, vx, 60, reach)), `window ${round}`).toBeLessThanOrEqual(turn);
    }
  });

  it('a guard stays a chaser of the sentence: the guard and the loot bodies carry the spec roles', () => {
    const world = worldOf(1);
    const state = instantiate(world);
    expect(guardsOf(state).every((guard) => state[bodyBase(guard) + BODY.role] === ROLE.chaser)).toBe(true);
    expect(world.kinds).toEqual(expect.arrayContaining(['hero', 'guard', 'loot']));
    expect(SPEC.roles.map((role) => [role.id, role.kind, role.label])).toEqual([
      ['player', 'player', 'fox'],
      ['loot', 'collectible', 'gem'],
      ['guard', 'chaser', 'robot'],
    ]);
  });
});

describe('steal genre module (P66 T7)', () => {
  it('compiles a valid genre.v6 spec from the hand spec; T12 routes sentences to it (ready, cues)', () => {
    // P66 T12: živý pro výběr – narážky v modulu, buňka receptu v `PRESETS` (`p66-staged.test.ts`).
    expect(stealGenre.availability('default')).toBe('ready');
    expect(stealGenre.cues.length).toBeGreaterThan(0);
    const read = readGenreSpec({ genre: 'steal', mode: 'default', hero: 'cat', setting: 'fish market', cast: [{ label: 'fish', does: 'collect' }, { label: 'dog', does: 'chase_me' }] });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const spec = compileWith(stealGenre as GenreModule, read.value);
    expect(spec.control).toBe('steal');
    expect(spec.genre).toEqual({ id: 'steal', mode: 'default', compilerVersion: 'genre.v6' });
    expect(arcadeWorldOf(spec, 1).ok).toBe(true);
    expect(readGenreSpec({ genre: 'steal', mode: 'default', hero: 'fox', setting: 'forest', params: { rounds: 5 } }).ok).toBe(false);
    // Ruční spec e2e je přesně překlad žánru – fixture se od modulu tiše neodchýlí.
    expect(JSON.parse(readFileSync(join(process.cwd(), 'e2e/fixtures/p66-steal-spec.json'), 'utf8'))).toEqual(spec);
  });

  it('reads the loot and the guards from the sentence cast, with defaults when the sentence names none', () => {
    const named = stealGenre.compile({ genre: 'steal', mode: 'default', hero: 'raccoon', setting: 'kitchen', cast: [{ label: 'cookies', does: 'collect' }, { label: 'dogs', does: 'chase_me' }] });
    expect(named.roles.find((role) => role.id === 'loot')?.label).toBe('cookie');
    expect(named.roles.find((role) => role.id === 'guard')?.label).toBe('dog');
    expect(named.tutorial.goalLine.length).toBeLessThanOrEqual(50);
    const plain = stealGenre.compile({ genre: 'steal', mode: 'default', hero: 'fox', setting: 'forest' });
    expect(plain.roles.find((role) => role.id === 'loot')?.label).toBe('gem');
    expect(plain.roles.find((role) => role.id === 'guard')?.label).toBe('robot');
    const fill = stealGenre.draftFill('a raccoon steals cookies while the dog chases it', null);
    expect(fill.genre).toBe('steal');
  });
});
