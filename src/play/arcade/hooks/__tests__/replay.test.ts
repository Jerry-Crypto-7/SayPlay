/**
 * Přehrání s háčky (P66 T3): zprávy háčků jádrem jen projdou (stav nemění), volba vylepšení v záznamu přehraje
 * shodně – dvě přehrání téhož záznamu dají týž hash jako robot, jiná volba jiný – a nečinný hráč nevolí.
 */

import { describe, expect, it } from 'vitest';

import { hashArcade, instantiate, loadProgram, replay, step } from '../../kernel';
import { type InputEvent, NO_INPUT } from '../../contract';
import { arcadeWorldOf, compileArcade } from '../../compile';
import { ARCADE_LIBRARY } from '../../library';
import { runBot, verifyArcade } from '../../verify';
import { UPGRADE_PICK_BUTTONS, isHookEffect } from '../contract';
import { hooksOf, upgradeLevel } from '../index';
import { PICK_MASK } from '../upgrades';
import { EVERY_HOOK_EFFECT, TEST_LIBRARY, fightSpec, item, ofKind, play, testWorld, worldOf } from './harness';

describe('the kernel only passes hook messages through', () => {
  it.each([
    ['without hooks', undefined],
    ['with hooks', { rounds: 3, clear: 'win' as const, rarity: true }],
  ])('%s: all eight hook messages come out of the tick and the state hash is the one of a tick without them', (_label, request) => {
    const loud = testWorld(2, [item(1)], [{ id: 'hook_messages', params: { tick: 4 } }], request);
    const quiet = testWorld(2, [item(1)], [{ id: 'hook_messages', params: { tick: 999 } }], request);
    const run = (world: typeof loud) => {
      const program = loadProgram(world, TEST_LIBRARY);
      const state = instantiate(world);
      const ticks = Array.from({ length: 8 }, () => step(state, NO_INPUT, program));
      return { state, ticks };
    };
    const a = run(loud);
    const b = run(quiet);
    expect(a.ticks[4]!.filter(isHookEffect)).toEqual(EVERY_HOOK_EFFECT);
    expect(b.ticks[4]!.filter(isHookEffect)).toEqual([]);
    expect(hashArcade(a.state)).toBe(hashArcade(b.state));
    expect(Array.from(a.state)).toEqual(Array.from(b.state));
  });
});

describe('a pick in the record replays the same', () => {
  it.each([1, 2, 3])('seed %i: the robot record with its picks replays twice to the robot hash and a win', (seed) => {
    const world = worldOf(fightSpec(), seed);
    const bot = runBot(world);
    expect(bot.inputs.filter((input) => (input.buttons & PICK_MASK) !== 0)).toHaveLength(2);
    const first = replay(world, bot.inputs, ARCADE_LIBRARY);
    const second = replay(world, bot.inputs, ARCADE_LIBRARY);
    expect(first).toEqual(second);
    expect(first.hash).toBe(bot.hash);
    expect(first.outcome).toBe('won');
  });

  it('another pick in the record is another game, and it too replays the same', () => {
    const world = worldOf(fightSpec(), 1);
    const bot = runBot(world);
    const keeper = hooksOf(world.rules)!.keeper as number;
    // Místo karty robota karta o jednu dál (v kruhu) u obou nabídek.
    const moved: InputEvent[] = bot.inputs.map((input) => ((input.buttons & PICK_MASK) === 0 ? input : { ...input, buttons: rotate(input.buttons) }));
    const theirs = play(world, bot.inputs, ARCADE_LIBRARY, { horizon: 1200 });
    const mine = play(world, moved, ARCADE_LIBRARY, { horizon: 1200 });
    const picked = (played: typeof mine) => ofKind(played, 'upgrade_pick').map((pick) => pick.upgrade);
    expect(picked(mine)).not.toEqual(picked(theirs));
    expect(upgradeLevel(mine.state, keeper, 'extra_life')).toBeLessThan(upgradeLevel(theirs.state, keeper, 'extra_life'));
    expect(hashArcade(play(world, moved, ARCADE_LIBRARY, { horizon: 1200 }).state)).toBe(hashArcade(mine.state));
    expect(hashArcade(mine.state)).not.toBe(hashArcade(theirs.state));
  });

  it.each([1, 2])('seed %i: the hand-written fight compiles and passes the publication gate', (seed) => {
    const spec = fightSpec();
    expect(compileArcade(spec, seed).ok).toBe(true);
    const made = arcadeWorldOf(spec, seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(verifyArcade(made.world, ARCADE_LIBRARY, made.roleBindings).failures).toEqual([]);
  });

  it('an idle player presses nothing, so no pick is in its record and it loses', () => {
    const world = worldOf(fightSpec(), 2);
    const idle = replay(world, [], ARCADE_LIBRARY);
    expect(idle.outcome).toBe('lost');
    expect(replay(world, [], ARCADE_LIBRARY)).toEqual(idle);
  });
});

/** Tlačítko karty k → karty k + 1 (v kruhu po třech). */
function rotate(buttons: number): number {
  const card = UPGRADE_PICK_BUTTONS.findIndex((button) => (buttons & button) !== 0);
  return (buttons & ~PICK_MASK) | (UPGRADE_PICK_BUTTONS[(card + 1) % UPGRADE_PICK_BUTTONS.length] as number);
}
