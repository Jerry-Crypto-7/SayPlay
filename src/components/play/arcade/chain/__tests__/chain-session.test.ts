/**
 * Relace řetězu v prohlížeči (P56C T11) proti přehrávači serveru: skriptovaný lidský běh – stisky tik po tiku
 * cestou klávesnice, i během karty – dá záznam, jehož `replayChain` je týž hash, výsledek, skóre, životy i tik.
 * Tempo (`rate`) zkrátí čas běhu, hash ani záznam nezmění.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { BUTTON, HEADER, type InputEvent, type ArcadeWorld } from '@/play/arcade/contract';
import { hashArcade } from '@/play/arcade/kernel';
import { runBot } from '@/play/arcade/verify';
import { buildChain } from '@/play/chain/build';
import type { ChainWorld } from '@/play/chain/contract';
import { readForChain } from '@/play/chain/read';
import { replayChain } from '@/play/chain/run';

import { createArcadeSession } from '../../session';
import { type ChainSession, createChainSession } from '../chain-session';

/** Dev P56C d04 (`multi_verb`): skákání a střelba. */
const MULTI = 'can u make one where a robot hops over lava cracks and shoots bubbles at grumpy clouds';
/** Krok hodin v ms – menší než tik i při tempu 1300, takže jeden `advance` odtiká nejvýš jeden tik. */
const STEP_MS = 4;

let chain: ChainWorld;

beforeAll(() => {
  const built = buildChain(MULTI, readForChain(MULTI, null), 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  chain = built.chain;
});

interface Driven {
  readonly ms: number;
  readonly cardPresses: number;
  /** Záznam, který skript opravdu stiskl, s globálními tiky. */
  readonly pressed: readonly InputEvent[];
}

/**
 * Hraje řetěz jako člověk: v kole stiskne vstup plánu v jeho tiku (osa jen pro ten tik), během karty mačká dál.
 * `plan` dostane svět kola, jak ho relace otevřela – boss s přenesenými životy.
 */
function drive(session: ChainSession, plan: (round: number, world: ArcadeWorld) => readonly InputEvent[]): Driven {
  let ms = 0;
  let cardPresses = 0;
  const pressed: InputEvent[] = [];
  let planned = -1;
  let events = new Map<number, InputEvent>();
  let start = 0;
  while (session.outcome() === 'running') {
    if (session.card() > 0) {
      session.press(BUTTON.TAP, 1);
      cardPresses += 1;
      session.advance(STEP_MS);
    } else {
      const round = session.current();
      if (session.round() !== planned) {
        planned = session.round();
        start = session.tick();
        events = new Map(plan(planned, round.world).map((event) => [event.tick, event]));
      }
      const tick = round.state()[HEADER.tick] as number;
      const event = events.get(tick);
      if (event !== undefined) {
        session.press(event.buttons, event.axis);
        if (pressed.at(-1)?.tick !== start + tick) pressed.push({ tick: start + tick, buttons: event.buttons, axis: event.axis });
      }
      round.advance(STEP_MS);
    }
    ms += STEP_MS;
  }
  return { ms, cardPresses, pressed };
}

const bot = (_round: number, world: ArcadeWorld): readonly InputEvent[] => runBot(world).inputs;

function expectSameAsServer(session: ChainSession): void {
  const replay = replayChain(chain, session.inputs());
  expect(replay.hash).toBe(session.hash());
  expect(replay.outcome).toBe(session.outcome());
  expect(replay.score).toBe(session.score());
  expect(replay.lives).toBe(session.lives());
  expect(replay.tick).toBe(session.tick());
  expect(replay.results).toEqual(session.results());
}

describe('createChainSession (P56C T11)', () => {
  it('a scripted human run with presses during the cards replays to the same hash on the server', () => {
    const session = createChainSession(chain);
    const run = drive(session, bot);
    expect(session.outcome()).toBe('won');
    expect(session.results()).toEqual(chain.rounds.map(() => 'won'));
    expect(run.cardPresses).toBeGreaterThan(0);
    // Stisky z karet do záznamu nejdou: záznam je přesně to, co skript stiskl v kolech.
    expect(session.inputs()).toEqual(run.pressed);
    expectSameAsServer(session);
  });

  it('a lost round costs one life, the chain goes on and the boss starts with the lives left', () => {
    const session = createChainSession(chain);
    const run = drive(session, (round, world) => (round === 1 ? [] : bot(round, world)));
    expect(session.results()[1]).toBe('lost');
    expect(session.lives()).toBe(chain.lives - 1);
    expect(session.results()).toHaveLength(chain.rounds.length);
    expect(session.inputs()).toEqual(run.pressed);
    expectSameAsServer(session);
  });

  it('three lost rounds end the chain early', () => {
    const session = createChainSession(chain);
    drive(session, () => []);
    expect(session.outcome()).toBe('lost');
    expect(session.lives()).toBe(0);
    expect(session.results()).toEqual(['lost', 'lost', 'lost']);
    expectSameAsServer(session);
  });

  it('the hash matches mid-chain too: while a round plays and while a card shows', () => {
    const session = createChainSession(chain);
    const world = session.current().world;
    const inputs = runBot(world).inputs;
    const events = new Map(inputs.map((event) => [event.tick, event]));
    while (session.card() === 0) {
      const event = events.get(session.current().state()[HEADER.tick] as number);
      if (event !== undefined) session.press(event.buttons, event.axis);
      session.current().advance(STEP_MS);
      if ((session.current().state()[HEADER.tick] as number) === 30) expect(replayChain(chain, session.inputs(), undefined, session.tick()).hash).toBe(session.hash());
    }
    session.advance(STEP_MS * 5);
    expect(session.card()).toBeGreaterThan(0);
    expect(replayChain(chain, session.inputs(), undefined, session.tick()).hash).toBe(session.hash());
  });

  it('restart starts the chain over from round 1 with a clean record', () => {
    const session = createChainSession(chain);
    drive(session, () => []);
    session.restart();
    expect(session.outcome()).toBe('running');
    expect(session.round()).toBe(0);
    expect(session.lives()).toBe(chain.lives);
    expect(session.inputs()).toEqual([]);
    drive(session, bot);
    expect(session.outcome()).toBe('won');
    expectSameAsServer(session);
  });
});

describe('rate (P56C T11)', () => {
  it('an arcade session at rate 1300 plays the same record in fewer ms with the same hash', () => {
    const world = chain.rounds[0]!.world;
    const inputs = runBot(world).inputs;
    const play = (rate: number): { readonly ms: number; readonly hash: string; readonly log: readonly InputEvent[] } => {
      const session = createArcadeSession(world, { rate });
      const events = new Map(inputs.map((event) => [event.tick, event]));
      let ms = 0;
      while (session.snapshot().runState === 'running') {
        const event = events.get(session.state()[HEADER.tick] as number);
        if (event !== undefined) session.press(event.buttons, event.axis);
        session.advance(STEP_MS);
        ms += STEP_MS;
      }
      return { ms, hash: hashArcade(session.state()), log: session.inputs() };
    };
    const normal = play(1000);
    const fast = play(1300);
    expect(fast.hash).toBe(normal.hash);
    expect(fast.log).toEqual(normal.log);
    expect(fast.ms).toBeLessThan(normal.ms * 0.8);
  });

  it('the chain plays its later rounds faster than at rate 1000 and the hash does not see it', () => {
    const flat: ChainWorld = { ...chain, rounds: chain.rounds.map((round) => ({ ...round, rate: 1000 })) };
    const rated = createChainSession(chain);
    const slow = createChainSession(flat);
    const fast = drive(rated, bot);
    const even = drive(slow, bot);
    expect(chain.rounds.at(-1)!.rate).toBeGreaterThan(1000);
    expect(rated.hash()).toBe(slow.hash());
    expect(rated.inputs()).toEqual(slow.inputs());
    expect(fast.ms).toBeLessThan(even.ms);
  });
});
