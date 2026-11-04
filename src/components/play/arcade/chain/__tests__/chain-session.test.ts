/**
 * Relace řetězu v prohlížeči (P56C T11) proti přehrávači serveru: skriptovaný lidský běh – stisky tik po tiku
 * cestou klávesnice, i během karty – dá záznam, jehož `replayChain` je týž hash, výsledek, skóre i tik.
 * P70A T3: každé kolo čeká na první dotek, hraje 60 Hz bez zrychlení, má dva životy a „Try again“ hraje prohrané kolo.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { ARCADE_LIMITS, BUTTON, COUNTER, HEADER, type InputEvent, NO_INPUT, type ArcadeWorld } from '@/play/arcade/contract';
import { hashArcade, instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { runBot } from '@/play/arcade/verify';
import { buildChain } from '@/play/chain/build';
import type { ChainWorld } from '@/play/chain/contract';
import { readForChain } from '@/play/chain/read';
import { replayChain } from '@/play/chain/run';

import { createArcadeSession, TICK_MS } from '../../session';
import { type ChainSession, createChainSession } from '../chain-session';

/** Dev P56C d04 (`multi_verb`): skákání a střelba. */
const MULTI = 'can u make one where a robot hops over lava cracks and shoots bubbles at grumpy clouds';
/** Krok hodin v ms – menší než tik, takže jeden `advance` odtiká nejvýš jeden tik. */
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
 * `plan` dostane svět kola, jak ho relace otevřela – s životy kola.
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

const HEALTH = HEADER.counters + COUNTER.health;

/** Tik, kdy nečinného hráče v kole poprvé něco zasáhne; `null` = kolo skončí dřív (třeba hodinami). */
function firstIdleHit(world: ArcadeWorld): number | null {
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const lives = state[HEALTH] as number;
  while (outcomeOf(state) === 'running' && (state[HEADER.tick] as number) < ARCADE_LIMITS.maxTicks) {
    step(state, NO_INPUT, program);
    if ((state[HEALTH] as number) < lives) return state[HEADER.tick] as number;
  }
  return null;
}

function expectSameAsServer(session: ChainSession): void {
  const replay = replayChain(chain, session.inputs());
  expect(replay.hash).toBe(session.hash());
  expect(replay.outcome).toBe(session.outcome());
  expect(replay.score).toBe(session.score());
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

  // P70A T3: dřív prohrané kolo stálo život řetězu a řetěz jel dál; teď ho zastaví.
  it('an idle player loses round 1 and the chain stops there', () => {
    const session = createChainSession(chain);
    drive(session, () => []);
    expect(session.outcome()).toBe('lost');
    expect(session.results()).toEqual(['lost']);
    expectSameAsServer(session);
  });

  // P70A T3 (pin): „Try again“ začne prohraným kolem, ne kolem 1 – vyhraná kola i jejich záznam zůstanou.
  it('Try again after a lost round plays that round again, keeps the won rounds and replays to the same hash', () => {
    const lost = 2;
    const session = createChainSession(chain);
    drive(session, (round, world) => (round === lost ? [] : bot(round, world)));
    expect(session.outcome()).toBe('lost');
    expect(session.results()).toEqual(['won', 'won', 'lost']);
    const kept = [...session.inputs()];
    const start = session.start();
    session.restart();
    expect(session.outcome()).toBe('running');
    expect(session.round()).toBe(lost);
    expect(session.card()).toBe(0);
    expect(session.results()).toEqual(['won', 'won']);
    expect(session.lives()).toBe(chain.lives);
    expect(session.start()).toBe(start);
    expect(session.tick()).toBe(start);
    expect(session.inputs()).toEqual(kept);
    drive(session, bot);
    expect(session.outcome()).toBe('won');
    expect(session.results()).toEqual(chain.rounds.map(() => 'won'));
    // Záznam = vyhraná kola a nový pokus; server ho přehraje od tiku 0 k témuž konci.
    expectSameAsServer(session);
    expect(session.score()).toBe(replayChain(chain, session.inputs()).score);
  });

  // P70A T3 (pin): kolo má dva životy – první zásah stojí jeden a kolo jede dál.
  it('every round opens with two lives, and a hit costs one while the round goes on', () => {
    const session = createChainSession(chain);
    // Nečinný hráč v prvním kole, kde ho něco zasáhne (ne jen doběhnou hodiny); dřív robot.
    const target = session.worlds.findIndex((world) => firstIdleHit(world) !== null);
    expect(target).toBeGreaterThanOrEqual(0);
    const opened: number[] = [];
    let hit: { readonly round: number; readonly lives: number; readonly runState: string } | null = null;
    let round = -1;
    let events = new Map<number, InputEvent>();
    while (session.outcome() === 'running' && hit === null) {
      if (session.card() > 0) {
        session.advance(STEP_MS);
        continue;
      }
      const live = session.current();
      if (session.round() !== round) {
        round = session.round();
        opened.push(session.lives());
        events = new Map((round === target ? [] : bot(round, live.world)).map((event) => [event.tick, event]));
      }
      const event = events.get(live.state()[HEADER.tick] as number);
      if (event !== undefined) session.press(event.buttons, event.axis);
      live.advance(STEP_MS);
      if (session.lives() < chain.lives) hit = { round, lives: session.lives(), runState: live.snapshot().runState };
    }
    expect(opened).toEqual(chain.rounds.slice(0, target + 1).map(() => chain.lives));
    expect(hit).toEqual({ round: target, lives: chain.lives - 1, runState: 'running' });
    expect(session.outcome()).toBe('running');
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

  it('after a won chain restart (Play again) starts over from round 1 with a clean record', () => {
    const session = createChainSession(chain);
    drive(session, bot);
    expect(session.outcome()).toBe('won');
    session.restart();
    expect(session.outcome()).toBe('running');
    expect(session.round()).toBe(0);
    expect(session.results()).toEqual([]);
    expect(session.lives()).toBe(chain.lives);
    expect(session.inputs()).toEqual([]);
    drive(session, bot);
    expect(session.outcome()).toBe('won');
    expectSameAsServer(session);
  });

  // P70A T3 (pin): každé kolo, i po kartě, čeká na první dotek – do té doby svět stojí a nikdo neprohraje.
  it('with the gate every round waits for the first touch: its world stands still and nothing is lost before it', () => {
    const session = createChainSession(chain, { gate: true });
    for (let round = 0; round < chain.rounds.length; round += 1) {
      expect(session.round()).toBe(round);
      expect(session.card()).toBe(0);
      const live = session.current();
      // 20 s bez doteku: hodiny kola stojí, stav je počáteční a kolo běží dál.
      for (let ms = 0; ms < 20_000; ms += 100) live.advance(100);
      expect(session.waiting()).toBe(true);
      expect(live.state()[HEADER.tick]).toBe(0);
      expect(hashArcade(live.state())).toBe(hashArcade(instantiate(live.world)));
      expect(live.snapshot().runState).toBe('running');
      expect(session.results()).toHaveLength(round);
      session.begin();
      expect(session.waiting()).toBe(false);
      // Dotek pustí kolo; robot kola ho dohraje a karta doběhne.
      const events = new Map(bot(round, live.world).map((event) => [event.tick, event]));
      while (session.card() === 0 && session.outcome() === 'running') {
        const event = events.get(live.state()[HEADER.tick] as number);
        if (event !== undefined) session.press(event.buttons, event.axis);
        live.advance(STEP_MS);
      }
      while (session.card() > 0) session.advance(STEP_MS);
    }
    expect(session.outcome()).toBe('won');
    expectSameAsServer(session);
  });
});

describe('tempo between rounds (P56C T11 → P70A T3)', () => {
  // P70A T3 (pin): dřív pozdější kola běžela rychleji (tempo až 1300); teď všechna 60 tiků za sekundu.
  it('every round of the chain plays 60 ticks a second: no speed-up between rounds', () => {
    const perRound: number[] = [];
    const session = createChainSession(chain);
    let round = -1;
    let ms = 0;
    let ticks = 0;
    let events = new Map<number, InputEvent>();
    while (session.outcome() === 'running') {
      if (session.card() > 0) {
        session.advance(STEP_MS);
        continue;
      }
      const live = session.current();
      if (session.round() !== round) {
        if (round >= 0) perRound.push(ms / ticks);
        round = session.round();
        ms = 0;
        events = new Map(bot(round, live.world).map((event) => [event.tick, event]));
      }
      const event = events.get(live.state()[HEADER.tick] as number);
      if (event !== undefined) session.press(event.buttons, event.axis);
      live.advance(STEP_MS);
      ms += STEP_MS;
      ticks = live.state()[HEADER.tick] as number;
    }
    perRound.push(ms / ticks);
    expect(session.outcome()).toBe('won');
    expect(perRound).toHaveLength(chain.rounds.length);
    // Milisekundy na tik v každém kole jako v kole 1: krok 4 ms dá odchylku nejvýš o zlomek tiku na kolo.
    // Staré tempo 1075 by dalo 15,5 ms, 1300 jen 12,8 ms na tik.
    for (const msPerTick of perRound) expect(Math.abs(msPerTick - TICK_MS)).toBeLessThan(0.5);
  });
});
