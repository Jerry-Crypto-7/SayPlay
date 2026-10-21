/**
 * Publikační brána řetězu `verifyChain` (P56C T6). Brána, která vždy projde, vypadá stejně jako ta, která
 * hlídá – proto ke každé kontrole řetěz, který ji musí shodit, a nečinný vítěz až ve třetím kole.
 */

import { describe, expect, it } from 'vitest';

import { draftGenreFor } from '@/play/draft/draft';

import type { ChainWorld } from '../contract';
import { MICRO, type MicroEntry, genreModeOf, microSpec } from '../micro';
import { chainFromSpecs, replayChain } from '../run';
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
