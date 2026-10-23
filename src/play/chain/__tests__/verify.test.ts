/**
 * Publikační brána řetězu `verifyChain` (P56C T6). Brána, která vždy projde, vypadá stejně jako ta, která
 * hlídá – proto ke každé kontrole řetěz, který ji musí shodit, a nečinný vítěz až ve třetím kole.
 */

import { describe, expect, it } from 'vitest';

import { ARCADE_HZ, ARCADE_LIMITS } from '@/play/arcade/contract';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { draftGenreFor } from '@/play/draft/draft';

import type { ChainWorld } from '../contract';
import { MICRO, type MicroEntry, genreModeOf, microSpec } from '../micro';
import { chainFromSpecs } from '../build';
import { chainMaxTicks, replayChain, roundClock } from '../run';
import { chainLengthSec, verifyChain } from '../verify';

const entryOf = (key: string): MicroEntry => MICRO.find((entry) => entry.key === key)!;

function chainOf(entries: readonly MicroEntry[], seed = 7): ChainWorld {
  const made = chainFromSpecs(seed, entries.map((entry, round) => {
    const { genre, mode } = genreModeOf(entry);
    return { spec: microSpec(draftGenreFor('a fox in a forest', genre, mode)!, entry, round), key: entry.key, card: entry.card, boss: entry.boss === true };
  }));
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.chain;
}

const GOOD = ['catch.default', 'hop.default', 'duel.default', 'shooter.default.boss'].map(entryOf);
/** Skákačka jako přežití: nečinný hráč stojí a hodiny ho nechají vyhrát. */
const IDLE_WINS: MicroEntry = { key: 'platformer.default', control: 'platform', kind: 'survive', seconds: 6, card: 'Jump!', params: { lengthM: 60, items: 1 } };
/** Sbírání v aréně robot do 8 s nedokáže (kalibrace T4). */
const BOT_LOSES: MicroEntry = { key: 'arena.collect', control: 'move_free', kind: 'achieve', seconds: 8, card: 'Grab!' };

const codes = (chain: ChainWorld): string[] => verifyChain(chain).failures.map((failure) => failure.split(':')[0]!);

describe('verifyChain', () => {
  const good = chainOf(GOOD);
  const verdict = verifyChain(good);

  it('passes a hand-built chain of four MICRO rounds', () => {
    expect(verdict.failures).toEqual([]);
    expect(verdict.controls).toBe(4);
    expect(verdict.lengthSec).toBeGreaterThanOrEqual(30);
    expect(verdict.par).not.toBeNull();
  });

  it('the bot record of the chain replays twice to the hash of its run', () => {
    const first = replayChain(good, verdict.inputs);
    const second = replayChain(good, verdict.inputs);
    expect(first.outcome).toBe('won');
    expect(first.hash).toBe(verdict.hash);
    expect(second.hash).toBe(verdict.hash);
    expect(verdict.par).toEqual({ score: first.score, ticks: first.tick });
  });

  it('fails chain_idle_loses when idle wins round 3', () => {
    expect(codes(chainOf([GOOD[0]!, GOOD[1]!, IDLE_WINS, GOOD[3]!]))).toContain('chain_idle_loses');
  });

  it('fails chain_controls with two controls', () => {
    expect(codes(chainOf(['catch.default', 'timing.stack', 'whack.default', 'defense.default.boss'].map(entryOf)))).toContain('chain_controls');
  });

  it('fails chain_length when the chain is under 30 s', () => {
    const short = chainOf(['timing.stack', 'shooter.default', 'flap.default'].map(entryOf));
    expect(codes(short)).toContain('chain_length');
    expect(verifyChain(short).lengthSec).toBeLessThan(30);
  });

  it('fails chain_bot_wins when the bot loses a round', () => {
    expect(codes(chainOf([GOOD[0]!, BOT_LOSES, GOOD[2]!, GOOD[3]!]))).toContain('chain_bot_wins');
  });

  it('chainLengthSec divides round ticks by the rate and adds a card between rounds', () => {
    expect(chainLengthSec(good, [600, 600, 600, 600])).toBeCloseTo(10 + 10 / 1.075 + 10 / 1.15 + 10 / 1.225 + 3, 6);
  });
});

/** Kolo `index` s pravidly, která vybere `edit` – řetěz jinak týž. */
const withRules = (chain: ChainWorld, index: number, edit: (rules: ChainWorld['rounds'][number]['world']['rules']) => ChainWorld['rounds'][number]['world']['rules']): ChainWorld => ({
  ...chain,
  rounds: chain.rounds.map((round, at) => (at === index ? { ...round, world: { ...round.world, rules: edit(round.world.rules) } } : round)),
});

describe('clock gate (debate T9: a dare record holds at most ARCADE_LIMITS.maxTicks)', () => {
  const good = chainOf(GOOD);

  it('a round ends at its clock: an idle achieve round loses on the clock tick, a survive round wins on it', () => {
    // Jen hodiny, bez kusů, které kolo ukončí dřív (nečinný na chytání prohraje propadlými kusy v ~400. tiku).
    const onlyClock = (index: number) => withRules(good, index, (rules) => rules.filter((rule) => rule.id === 'time_limit' || rule.id === 'rule_tick')).rounds[index]!.world;
    const catchClock = onlyClock(0);
    expect(roundClock(catchClock)).toBe(10 * ARCADE_HZ + 1);
    expect(replay(catchClock, [], ARCADE_LIBRARY)).toMatchObject({ outcome: 'lost', tick: 10 * ARCADE_HZ + 1 });
    const hopClock = onlyClock(1);
    expect(roundClock(hopClock)).toBe(7 * ARCADE_HZ);
    expect(replay(hopClock, [], ARCADE_LIBRARY)).toMatchObject({ outcome: 'won', tick: 7 * ARCADE_HZ });
    const bot = verifyChain(good).rounds[1]!.bot;
    expect(bot).toMatchObject({ outcome: 'won', tick: roundClock(good.rounds[1]!.world) });
  });

  it('chainMaxTicks is the sum of the round clocks plus the cards, and no run of the chain outlasts it', () => {
    const clocks = good.rounds.map((round) => roundClock(round.world)!);
    expect(chainMaxTicks(good)).toBe(clocks.reduce((sum, ticks) => sum + ticks, 0) + 3 * good.cardTicks);
    expect(replayChain(good, []).tick).toBeLessThanOrEqual(chainMaxTicks(good)!);
    expect(replayChain(good, verifyChain(good).inputs).tick).toBeLessThanOrEqual(chainMaxTicks(good)!);
  });

  it('fails chain_clock when a round has no clock', () => {
    const unclocked = withRules(good, 1, (rules) => rules.filter((rule) => rule.id !== 'rule_tick' && rule.id !== 'time_limit'));
    expect(roundClock(unclocked.rounds[1]!.world)).toBeNull();
    expect(chainMaxTicks(unclocked)).toBeNull();
    expect(codes(unclocked)).toContain('chain_clock');
  });

  it('a conditional rule tick is not a clock', () => {
    const conditional = withRules(good, 1, (rules) => rules.map((rule) => (rule.id === 'rule_tick' ? { ...rule, params: { ...rule.params, if: [{ counter: 'score', atLeast: 1 }] } } : rule)));
    expect(roundClock(conditional.rounds[1]!.world)).toBeNull();
  });

  it('fails chain_ticks when the longest run is over ARCADE_LIMITS.maxTicks', () => {
    const slow = withRules(good, 0, (rules) => rules.map((rule) => (rule.id === 'time_limit' ? { ...rule, params: { seconds: ARCADE_LIMITS.maxTicks / ARCADE_HZ } } : rule)));
    expect(chainMaxTicks(slow)).toBeGreaterThan(ARCADE_LIMITS.maxTicks);
    expect(codes(slow)).toContain('chain_ticks');
    expect(codes(good)).not.toContain('chain_ticks');
  });
});
