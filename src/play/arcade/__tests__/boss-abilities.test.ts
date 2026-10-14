/**
 * Boss běžce a akce hrdiny (P46B T8, po sloučení s P46A): boss finále běžce (`behaviours/boss.ts`, role hazard
 * se třemi HP) padá uhnutými útoky; s akcí `strike` mu ubere život i úder v dosahu – jeden za úder, počítá se jen
 * první tik okna. Sloučení by ho mohlo od akcí potichu odpojit: úder P46A bral jen nepřátele a pronásledovatele.
 *
 * Hru hraje robot akcí té samé hry (s úderem), test přehrává jeho vlastní vstupy a úder k nim přidá nebo ubere.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { readGameSpec, type GameSpecV1 } from '../../spec';
import { ABILITY_TIMING, abilityActive, abilityCooldown } from '../abilities/state';
import { STRIKE, inStrikeReach } from '../abilities/strike';
import { arcadeWorldOf, preloadPhysics } from '../compile';
import { type ArcadeInput, type ArcadeWorld, BODY, BUTTON, FLAG, HEADER, NO_INPUT, bodyBase, bodyHp } from '../contract';
import { instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { matches } from '../pieces/behaviours';
import { refsOf } from '../pieces/behaviours/__tests__/harness';
import { runBot } from '../verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';

const SEEDS = [1, 2, 3];
const WINDOW = ABILITY_TIMING.strike.active;

const runner = compileRecipe(assemblyOfCell(liveCells().find((cell) => cell.id === 'runner.default')!));

function withStrike(): GameSpecV1 {
  const read = readGameSpec({ ...runner, abilities: ['strike'] });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
}

function worldOf(seed: number): ArcadeWorld {
  const made = arcadeWorldOf(withStrike(), seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Živá kopie předlohy bosse, nebo −1. */
function bossBody(state: Int32Array, template: number): number {
  for (let b = state[HEADER.spawnBase] as number; b < (state[HEADER.bodyCount] as number); b += 1) if (alive(state, b) && matches(state, b, template)) return b;
  return -1;
}

interface Game {
  readonly world: ArcadeWorld;
  readonly template: number;
  readonly keeper: number;
  /** Vstup robota akcí v tiku (robot zapisuje jen nenulové). */
  readonly bot: (tick: number) => ArcadeInput;
}

function gameOf(seed: number): Game {
  const world = worldOf(seed);
  const strike = world.rules.find((rule) => rule.id === 'ability_strike')!;
  const byTick = new Map(runBot(world).inputs.map((event) => [event.tick, event]));
  return { world, template: refsOf(world).find((ref) => ref.id === 'boss')!.template, keeper: strike.params.keeper as number, bot: (tick) => byTick.get(tick) ?? NO_INPUT };
}

/** Úder přidat (`true`), ubrat (`false`), nebo nechat robotovi (`undefined`). */
type Press = (state: Int32Array, tick: number) => boolean | undefined;

/** Přehraje hru do `until` (nebo do konce); `trace` vidí stav po každém tiku. */
function play(game: Game, press: Press, until: (state: Int32Array, tick: number) => boolean, trace?: (state: Int32Array, tick: number) => void): { state: Int32Array; tick: number } {
  const program = loadProgram(game.world, ARCADE_LIBRARY);
  const state = instantiate(game.world);
  let tick = 0;
  for (; tick < 20_000 && outcomeOf(state) === 'running' && !until(state, tick); tick += 1) {
    const move = game.bot(tick);
    const want = press(state, tick);
    const buttons = want === undefined ? move.buttons : want ? move.buttons | BUTTON.ACTION_A : move.buttons & ~BUTTON.ACTION_A;
    step(state, { ...move, buttons }, program);
    trace?.(state, tick);
  }
  return { state, tick };
}

/** Boss v dosahu úderu hráče, nebo −1. */
function bossInReach(state: Int32Array, template: number, ahead = 0): number {
  const boss = bossBody(state, template);
  return boss >= 0 && inStrikeReach(state, state[HEADER.player] as number, boss, ahead) ? boss : -1;
}

/** Úder by teď vyšel: akce bez cooldownu a mimo okno. */
const ready = (state: Int32Array, game: Game): boolean => abilityCooldown(state, game.keeper, 0) === 0 && abilityActive(state, game.keeper, 0) === 0;

beforeAll(async () => {
  await preloadPhysics(withStrike(), loadRapier);
});

describe('runner boss and the strike ability', () => {
  it.each(SEEDS)('one strike window takes exactly one life off the boss, though the boss stays in reach for several ticks (seed %i)', (seed) => {
    const game = gameOf(seed);
    // Robot nájezd bosse uhne do vedlejšího pruhu, kam úder nedosáhne. Těsně před nájezdem s plnými životy
    // proto hráče test postaví do pruhu bosse a hru odtud přehraje dvakrát: s úderem a bez něj.
    const dz = (state: Int32Array, boss: number): number => (state[bodyBase(boss) + BODY.z] as number) - (state[bodyBase(state[HEADER.player] as number) + BODY.z] as number);
    const near = play(game, () => undefined, (state) => {
      const boss = bossBody(state, game.template);
      return boss >= 0 && bodyHp(state, boss) > 1 && dz(state, boss) > 0 && dz(state, boss) <= STRIKE.reach && ready(state, game);
    });
    const boss = bossBody(near.state, game.template);
    expect(boss, 'the boss charges at the player').toBeGreaterThanOrEqual(0);
    near.state[bodyBase(near.state[HEADER.player] as number) + BODY.x] = near.state[bodyBase(boss) + BODY.x] as number;
    const program = loadProgram(game.world, ARCADE_LIBRARY);
    const window = (press: boolean): { hp: number; reach: number } => {
      const state = near.state.slice();
      let reach = 0;
      for (let k = 0; k <= WINDOW; k += 1) {
        if (k < WINDOW && bossInReach(state, game.template) === boss) reach += 1;
        step(state, press && k === 0 ? { ...NO_INPUT, buttons: BUTTON.ACTION_A } : NO_INPUT, program);
      }
      return { hp: alive(state, boss) ? bodyHp(state, boss) : 0, reach };
    };
    const struck = window(true);
    const idle = window(false);
    expect(struck.reach, 'the boss stays in reach for more than the first tick of the window').toBeGreaterThanOrEqual(2);
    expect(struck.hp).toBe(idle.hp - 1);
  });

  it.each(SEEDS)('strikes bring the boss down sooner and the game is still won (seed %i)', (seed) => {
    const game = gameOf(seed);
    const fall = (strike: boolean): { tick: number; won: boolean } => {
      const press: Press = (state) => (strike && bossInReach(state, game.template) >= 0 && ready(state, game) ? true : undefined);
      let boss = -1;
      const down = play(game, press, (state) => {
        if (boss < 0) boss = bossBody(state, game.template);
        return boss >= 0 && !alive(state, boss);
      });
      return { tick: down.tick, won: outcomeOf(play(game, press, () => false).state) === 'won' };
    };
    const dodged = fall(false);
    const struck = fall(true);
    expect(dodged.won).toBe(true);
    expect(struck.won).toBe(true);
    expect(struck.tick).toBeLessThan(dodged.tick);
  });
});
