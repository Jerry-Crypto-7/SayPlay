/**
 * Kola (P66 T3): souboj ze 3 vln = 3 kol skončí výhrou až po třetím `round_clear`; výhra pravidla před posledním
 * kolem je jen vyčištěné kolo (`clear: 'win'`) nebo počká (`clear: 'wave'`); přestávka svět zastaví a tik běží dál;
 * rozvrh kol ze streamu `rounds`; hra `genre.v5` háčky nemá.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../../compile';
import { BODY_STRIDE, HEADER, HEADER_SIZE, RUN_STATE } from '../../contract';
import { ARCADE_LIBRARY } from '../../library';
import { runBot } from '../../verify';
import { HOOK_SLOTS, ROUNDS } from '../contract';
import { hooksOf, roundOf, roundSeeds } from '../index';
import { fightSpec, fightTuned, item, ofKind, play, testWorld, TEST_LIBRARY, worldOf } from './harness';

const SEEDS = [1, 2, 3];

describe('rounds of the arena fight from a hand-written genre.v6 spec', () => {
  it.each(SEEDS)('seed %i: three rounds, each cleared once, and the win only after the third round_clear', (seed) => {
    const world = worldOf(fightSpec(), seed);
    expect(hooksOf(world.rules)).toMatchObject({ rounds: 3, clear: 'wave' });
    const bot = runBot(world);
    expect(bot.outcome).toBe('won');
    const played = play(world, bot.inputs);
    expect(played.state[HEADER.runState]).toBe(RUN_STATE.won);
    const clears = ofKind(played, 'round_clear');
    const starts = ofKind(played, 'round_start');
    expect(clears.map((event) => [event.round, event.rounds])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(starts.map((event) => event.round)).toEqual([0, 1, 2]);
    // Výhra až v tiku třetího round_clear – do té doby běh trvá.
    const lastTick = played.effects.length - 1;
    expect(clears[2]!.tick).toBe(lastTick);
    expect(clears[1]!.tick).toBeLessThan(starts[2]!.tick);
  });

  it('round_start of the next round comes right after the pick, with no reload', () => {
    const world = worldOf(fightSpec(), 1);
    const played = play(world, runBot(world).inputs);
    const picks = ofKind(played, 'upgrade_pick');
    const starts = ofKind(played, 'round_start').slice(1);
    expect(starts.map((start) => start.tick)).toEqual(picks.map((pick) => pick.tick));
  });

  it('the break stops the world: every body and counter stands still while the tick runs on', () => {
    const world = worldOf(fightSpec(), 2);
    const played = play(world, runBot(world).inputs, ARCADE_LIBRARY, { snapshots: true });
    const offer = ofKind(played, 'upgrade_offer')[0]!;
    const keeper = hooksOf(world.rules)!.keeper;
    // Vše kromě tiku a počítadla háčků (odpočet přestávky).
    const frozen = (state: Int32Array): number[] =>
      Array.from(state).filter((_, at) => at !== HEADER.tick && (at < HEADER_SIZE + keeper * BODY_STRIDE || at >= HEADER_SIZE + (keeper + 1) * BODY_STRIDE));
    const before = played.states[offer.tick]!;
    const during = played.states[offer.tick + 3]!;
    expect(frozen(during)).toEqual(frozen(before));
    expect(during[HEADER.tick]).toBe((before[HEADER.tick] as number) + 3);
  });

  it('an idle player never clears a round and loses', () => {
    const played = play(worldOf(fightSpec(), 2), []);
    expect(played.state[HEADER.runState]).toBe(RUN_STATE.lost);
    expect(ofKind(played, 'round_clear')).toEqual([]);
    expect(ofKind(played, 'round_start').map((event) => event.round)).toEqual([0]);
  });
});

describe('rounds ended by the genre win (clear: win, the new genres)', () => {
  const winsAt = (at: readonly number[]) => testWorld(5, [item(1)], [{ id: 'win_at', params: { at } }], { rounds: 3, clear: 'win' });

  it('a win in round 1 and 2 clears the round; only the win in round 3 ends the game', () => {
    const played = play(winsAt([10, 200, 400]), [], TEST_LIBRARY);
    expect(ofKind(played, 'round_clear').map((event) => [event.round, event.tick])).toEqual([
      [0, 10],
      [1, 200],
      [2, 400],
    ]);
    expect(ofKind(played, 'round_start').map((event) => [event.round, event.tick])).toEqual([
      [0, 0],
      [1, 10 + ROUNDS.breakTicks],
      [2, 200 + ROUNDS.breakTicks],
    ]);
    expect(played.state[HEADER.runState]).toBe(RUN_STATE.won);
    expect(played.state[HEADER.tick]).toBe(401);
  });

  it('a single win is one cleared round, not a won game', () => {
    const played = play(winsAt([10]), [], TEST_LIBRARY, { horizon: 600 });
    expect(played.state[HEADER.runState]).toBe(RUN_STATE.running);
    expect(roundOf(played.state, hooksOf(winsAt([10]).rules)!.keeper)).toBe(1);
  });

  it('a win while the wave genre is still in an earlier round waits (clear: wave)', () => {
    const world = testWorld(5, [item(1)], [{ id: 'win_at', params: { at: [10, 11, 12] } }], { rounds: 3, clear: 'wave' });
    const played = play(world, [], TEST_LIBRARY, { horizon: 100 });
    expect(played.state[HEADER.runState]).toBe(RUN_STATE.running);
    expect(ofKind(played, 'round_clear')).toEqual([]);
  });

  it('a world with one round has no round messages and wins at once', () => {
    const world = testWorld(5, [item(1)], [{ id: 'win_at', params: { at: [10] } }], { rounds: 1 });
    const played = play(world, [], TEST_LIBRARY);
    expect(played.events.filter((event) => event.kind === 'round_start' || event.kind === 'round_clear')).toEqual([]);
    expect(played.state[HEADER.runState]).toBe(RUN_STATE.won);
  });
});

describe('the round schedule and the saved games', () => {
  it('roundSeeds: the same seed gives the same schedule, other seeds other ones', () => {
    expect(roundSeeds(7, 4)).toEqual(roundSeeds(7, 4));
    const schedules = [1, 2, 3, 4, 5].map((seed) => roundSeeds(seed, 4).join(','));
    expect(new Set(schedules).size).toBe(5);
  });

  it('a genre.v5 spec has no hooks, and its tuning still refuses the hook keys', () => {
    const plain = arcadeWorldOf(fightTuned(({ hookRounds: _r, hookUpgrades: _u, ...rest }) => rest, 'genre.v5'), 1);
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(hooksOf(plain.world.rules)).toBeNull();
    expect(plain.world.bot.id).not.toBe('hooks_bot');
    const asked = arcadeWorldOf(fightTuned((tuning) => tuning, 'genre.v5'), 1);
    expect(asked.ok).toBe(false);
  });

  it('hooks only add to the genre.v6 world: one counter body, the hooks rule and the bot wrapper', () => {
    const plain = worldOf(fightTuned(({ hookRounds: _r, hookUpgrades: _u, ...rest }) => rest), 1);
    const hooked = worldOf(fightSpec(), 1);
    expect(hooksOf(plain.rules)).toBeNull();
    const keeper = hooksOf(hooked.rules)!.keeper;
    const bodies = (world: typeof plain): number[] => world.initial.slice(HEADER_SIZE, HEADER_SIZE + keeper * BODY_STRIDE);
    expect(bodies(hooked)).toEqual(bodies(plain));
    expect(hooked.initial.length).toBe(plain.initial.length + BODY_STRIDE);
    expect(hooked.rules.filter((ref) => ref.id !== 'hooks')).toEqual(plain.rules);
    expect(hooked.bot).toEqual({ id: 'hooks_bot', params: { base: plain.bot, keeper } });
    expect(hooked.control).toEqual(plain.control);
  });

  it('rounds that do not match the waves, or upgrades that would do nothing, are refused with a reason', () => {
    const issues = (edit: (tuning: Record<string, unknown>) => Record<string, unknown>): string => {
      const made = arcadeWorldOf(fightTuned(edit), 1);
      return made.ok ? '' : made.issues.join(' ');
    };
    expect(issues((tuning) => ({ ...tuning, waves: 4 }))).toMatch(/hookRounds: 3 rounds but the game has 4 waves/);
    expect(issues((tuning) => ({ ...tuning, hookUpgrades: 'speed,magnet,extra_life' }))).toMatch(/magnet would do nothing/);
    expect(issues((tuning) => ({ ...tuning, hookUpgrades: 'speed,extra_life' }))).toMatch(/at least 3 different upgrades/);
    expect(issues((tuning) => ({ ...tuning, hookRounds: 1 }))).toMatch(/picked between rounds/);
  });

  it('the hook slots start at zero: round 0, no break, no offer', () => {
    const world = worldOf(fightSpec(), 3);
    const base = HEADER_SIZE + hooksOf(world.rules)!.keeper * BODY_STRIDE;
    for (const slot of Object.values(HOOK_SLOTS)) expect(world.initial[base + slot]).toBe(0);
  });
});
