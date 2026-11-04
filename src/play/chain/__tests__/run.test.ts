/**
 * Přehrávač řetězu a hash `chain-v1` (P56C T5). Hash rozhoduje bez člověka, jestli server Dare přijme:
 * špatný posun tiků mezi koly hraje normálně a rozbije jen cizí replay, proto se kola řetězu porovnávají
 * s přehráním svých světů jádrem kolo po kole.
 */

import { describe, expect, it } from 'vitest';

import { COUNTER, HEADER, type InputEvent, NO_INPUT } from '@/play/arcade/contract';
import { outcomeOf, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { type BotRun, runBot } from '@/play/arcade/verify';
import { draftGenreFor } from '@/play/draft/draft';
import { SUBSYSTEMS, createStreams, nextInt } from '@/sim/rng';

import { CARD_TICKS, CHAIN_LIVES, CHAIN_RUNTIME_VERSION, type ChainWorld } from '../contract';
import { MICRO, genreModeOf, microSpec } from '../micro';
import { chainFromSpecs } from '../build';
import { type ChainState, hashChain, replayChain, roundSeeds, startChain, stepChain } from '../run';

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

const HEALTH = HEADER.counters + COUNTER.health;

/** Krokuje řetěz záznamem `events`, dokud `until` nevrátí true nebo řetěz neskončí. */
function stepUntil(run: ChainState, events: readonly InputEvent[], until: (run: ChainState) => boolean): void {
  let next = 0;
  while (run.outcome === 'running' && !until(run)) {
    while (next < events.length && events[next]!.tick < run.tick) next += 1;
    const event = events[next];
    stepChain(run, event !== undefined && event.tick === run.tick ? event : NO_INPUT);
  }
}

describe('chain contract', () => {
  it('stamps chain-v1, two lives per round, a one-second card and no tempo per round (P70A T3)', () => {
    expect(current.runtimeVersion).toBe(CHAIN_RUNTIME_VERSION);
    expect(CHAIN_LIVES).toBe(2);
    expect(current.lives).toBe(CHAIN_LIVES);
    expect(current.cardTicks).toBe(CARD_TICKS);
    // Zrychlování pozdějších kol (`rate` 1000 → 1300) je pryč: kolo nenese žádné tempo, všechna hrají 60 Hz.
    expect(current.rounds.filter((round) => 'rate' in round)).toEqual([]);
  });

  it('draws round seeds from the chain stream, appended after merge', () => {
    // Za `chain` přibyly jen streamy háčků P66 (T2), takže `chain` zůstal sedmý.
    expect(SUBSYSTEMS.indexOf('chain')).toBe(6);
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
    expect(first.results).toEqual(KEYS.map(() => 'won'));
    expect(first.hash).toBe(second.hash);
  });

  it('plays every round exactly as the kernel replays its world with the two lives of the round', () => {
    const worlds = current.rounds.map((round) => ({ ...round.world, initial: round.world.initial.map((value, index) => (index === HEALTH ? CHAIN_LIVES : value)) }));
    const result = replayChain(current, inputs);
    expect(result.roundHashes).toEqual(worlds.map((world, index) => replay(world, runs[index]!.inputs, ARCADE_LIBRARY).hash));
  });

  // P70A T3 (pin): kolo je postavené s jedním životem, řetěz ho otevře se dvěma – každé, boss taky.
  it('opens every round, the boss too, with two lives', () => {
    const run = startChain(current);
    const opened: number[] = [];
    let round = -1;
    stepUntil(run, inputs, (state) => {
      if (state.card === 0 && state.round !== round) {
        round = state.round;
        opened.push(state.state[HEALTH] as number);
      }
      return false;
    });
    expect(run.outcome).toBe('won');
    expect(current.rounds.map((plan) => plan.world.initial[HEALTH])).toEqual(KEYS.map(() => 1));
    expect(opened).toEqual(KEYS.map(() => CHAIN_LIVES));
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

  // P70A T3: dřív prohrané kolo stálo život řetězu a hrálo se dál; teď řetěz zastaví a „Try again“ hraje to kolo znovu.
  it('a lost round stops the chain at that round', () => {
    const result = replayChain(current, compose(played(new Set([1]))));
    expect(result.results).toEqual(['won', 'lost']);
    expect(result.outcome).toBe('lost');
    expect(replayChain(current, []).results).toEqual(['lost']);
  });

  it('a lost boss round loses the chain', () => {
    const result = replayChain(current, compose(played(new Set([3]))));
    expect(result.results).toEqual(['won', 'won', 'won', 'lost']);
    expect(result.outcome).toBe('lost');
  });

  // P70A T3 (pin): boss na první zásah neskončí – stojí život jako každý jiný a kolo i řetěz jedou dál.
  it('the first hit in a boss round costs one life and the chain goes on', () => {
    const bossKeys = ['catch.default', 'timing.stack', 'duel.default.boss'] as const;
    const chain = chainOf(bossKeys);
    const bots = chain.rounds.map((round) => runBot(round.world));
    const events = compose(bots.slice(0, -1).map((run) => ({ inputs: run.inputs, ticks: run.tick })));
    const run = startChain(chain);
    stepUntil(run, events, (state) => state.round === bossKeys.length - 1 && state.card === 0);
    expect(run.state[HEALTH]).toBe(CHAIN_LIVES);
    // Nečinný hráč v bossovi: první zásah.
    stepUntil(run, [], (state) => (state.state[HEALTH] as number) < CHAIN_LIVES);
    expect(run.state[HEALTH]).toBe(CHAIN_LIVES - 1);
    expect(outcomeOf(run.state)).toBe('running');
    expect(run.outcome).toBe('running');
    expect(run.results).toEqual(['won', 'won']);
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
