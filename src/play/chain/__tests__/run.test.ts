/**
 * Přehrávač řetězu a hash `chain-v1` (P56C T5). Hash rozhoduje bez člověka, jestli server Dare přijme:
 * špatný posun tiků mezi koly hraje normálně a rozbije jen cizí replay, proto se kola řetězu porovnávají
 * s přehráním svých světů jádrem kolo po kole.
 */

import { describe, expect, it } from 'vitest';

import { COUNTER, HEADER, type InputEvent } from '@/play/arcade/contract';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { type BotRun, runBot } from '@/play/arcade/verify';
import { draftGenreFor } from '@/play/draft/draft';
import { SUBSYSTEMS, createStreams, nextInt } from '@/sim/rng';

import { CARD_TICKS, CHAIN_LIVES, CHAIN_RUNTIME_VERSION, type ChainWorld, RATE_STEPS } from '../contract';
import { MICRO, genreModeOf, microSpec } from '../micro';
import { chainFromSpecs, hashChain, replayChain, roundSeeds, startChain, stepChain } from '../run';

const SEED = 42;
const KEYS = ['catch.default', 'timing.stack', 'flap.default', 'shooter.default.boss'] as const;

function chainOf(keys: readonly string[], seed = SEED): ChainWorld {
  const plans = keys.map((key, round) => {
    const entry = MICRO.find((candidate) => candidate.key === key)!;
    const { genre, mode } = genreModeOf(entry);
    return { spec: microSpec(draftGenreFor('a fox in a forest', genre, mode)!, entry, round), key: entry.key, card: entry.card, boss: entry.boss === true };
  });
  const made = chainFromSpecs(seed, plans);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.chain;
}

/** Záznamy kol na globální tiky: kolo r začne po konci kola r − 1 a kartě `CARD_TICKS`. */
function compose(runs: readonly { readonly inputs: readonly InputEvent[]; readonly ticks: number }[]): InputEvent[] {
  const out: InputEvent[] = [];
  let start = 0;
  for (const run of runs) {
    for (const event of run.inputs) out.push({ ...event, tick: event.tick + start });
    start += run.ticks + CARD_TICKS;
  }
  return out;
}

const current = chainOf(KEYS);
const runs: readonly BotRun[] = current.rounds.map((round) => runBot(round.world));
/** Robot v každém kole, kromě kol v `idle` – tam nečinný hráč až do prohry kola. */
const played = (idle: ReadonlySet<number> = new Set()) =>
  runs.map((run, index) => (idle.has(index) ? { inputs: [], ticks: replay(current.rounds[index]!.world, [], ARCADE_LIBRARY).tick } : { inputs: run.inputs, ticks: run.tick }));

describe('chain contract', () => {
  it('stamps chain-v1, three lives, a one-second card and rising rates', () => {
    expect(current.runtimeVersion).toBe(CHAIN_RUNTIME_VERSION);
    expect(current.lives).toBe(CHAIN_LIVES);
    expect(current.cardTicks).toBe(CARD_TICKS);
    expect(current.rounds.map((round) => round.rate)).toEqual(RATE_STEPS.slice(0, KEYS.length));
  });

  it('draws round seeds from the chain stream appended last', () => {
    expect(SUBSYSTEMS.at(-1)).toBe('chain');
    const stream = createStreams(SEED).chain;
    const expected = KEYS.map(() => nextInt(stream, 1, 0x7fffffff));
    expect(roundSeeds(SEED, KEYS.length)).toEqual(expected);
    expect(current.rounds.map((round) => round.world.seed)).toEqual(expected);
  });
});

describe('replayChain', () => {
  const inputs = compose(played());

  it('wins the chain with the bot of every round and gives the same hash twice', () => {
    const first = replayChain(current, inputs);
    const second = replayChain(current, inputs);
    expect(first.outcome).toBe('won');
    expect(first.lives).toBe(CHAIN_LIVES);
    expect(first.hash).toBe(second.hash);
  });

  it('plays every round exactly as the kernel replays its world, the boss with the lives left', () => {
    const health = HEADER.counters + COUNTER.health;
    const worlds = current.rounds.map((round) => (round.boss ? { ...round.world, initial: round.world.initial.map((value, index) => (index === health ? CHAIN_LIVES : value)) } : round.world));
    const result = replayChain(current, inputs);
    expect(result.roundHashes).toEqual(worlds.map((world, index) => replay(world, runs[index]!.inputs, ARCADE_LIBRARY).hash));
  });

  it('drops inputs during the card and keeps the hash', () => {
    const clean = replayChain(current, inputs);
    let start = 0;
    const noise: InputEvent[] = [];
    for (const run of runs.slice(0, -1)) {
      start += run.tick;
      for (let tick = start; tick < start + CARD_TICKS; tick += 7) noise.push({ tick, buttons: 1, axis: 600 });
      start += CARD_TICKS;
    }
    const noisy = [...inputs, ...noise].sort((a, b) => a.tick - b.tick);
    expect(replayChain(current, noisy).hash).toBe(clean.hash);
  });

  it('a lost round costs one life and the next round still plays', () => {
    const result = replayChain(current, compose(played(new Set([0]))));
    expect(result.results).toEqual(['lost', 'won', 'won', 'won']);
    expect(result.lives).toBe(CHAIN_LIVES - 1);
    expect(result.outcome).toBe('won');
  });

  it('no lives left ends the chain lost', () => {
    const result = replayChain(current, []);
    expect(result.results).toEqual(['lost', 'lost', 'lost']);
    expect(result.lives).toBe(0);
    expect(result.outcome).toBe('lost');
  });

  it('a lost boss round loses the chain', () => {
    const result = replayChain(current, compose(played(new Set([3]))));
    expect(result.results.at(-1)).toBe('lost');
    expect(result.outcome).toBe('lost');
  });

  it('the boss round starts with the lives the chain has left, and the bot wins it with 1 and with 3', () => {
    for (const [idle, lives] of [[new Set<number>(), 3], [new Set([0, 1]), 1]] as const) {
      const state = startChain(current);
      const events = compose(played(idle));
      let next = 0;
      while (state.round < 3 || state.card > 0) {
        while (next < events.length && events[next]!.tick < state.tick) next += 1;
        const event = events[next];
        stepChain(state, event !== undefined && event.tick === state.tick ? event : { buttons: 0, axis: 0 });
      }
      expect(state.state[HEADER.counters + COUNTER.health]).toBe(lives);
      expect(replayChain(current, events).outcome).toBe('won');
    }
  });

  it('hashChain of a stepped state equals the replay hash', () => {
    const state = startChain(current);
    let next = 0;
    while (state.outcome === 'running') {
      const event = inputs[next];
      if (event !== undefined && event.tick === state.tick) next += 1;
      stepChain(state, event !== undefined && event.tick === state.tick ? event : { buttons: 0, axis: 0 });
    }
    expect(hashChain(state)).toBe(replayChain(current, inputs).hash);
  });
});
