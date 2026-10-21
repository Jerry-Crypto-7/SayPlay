/**
 * Relace řetězu mikroher v prohlížeči (P56C T11): jedna `ArcadeSession` na kolo, mezi koly karta se slovesem.
 *
 * Kolo hraje obyčejná relace arkády s tempem kola (`rate`), takže scéna, vstupy i HUD kola jsou tytéž jako u
 * jedné hry a jeho hodiny pohání jeho scéna. Relace řetězu jen skládá: kolo r začne v globálním tiku
 * `starts[r]` a jeho místní tik t je globální `starts[r] + t`; po konci kola běží `cardTicks` tiků karty, během
 * nichž žádná relace kola neběží a stisky se zahodí. Životy, skóre a hash `chain-v1` počítá týmiž pravidly jako
 * `stepChain` (`src/play/chain/run.ts`), takže `replayChain(chain, inputs())` dá týž hash.
 */

import { COUNTER, HEADER, type InputEvent } from '@/play/arcade/contract';
import { type ArcadeOutcome, outcomeOf } from '@/play/arcade/kernel';
import type { ChainWorld } from '@/play/chain/contract';
import { hashChain, roundWorld } from '@/play/chain/run';

import { holdUntilTouch } from '../ready-gate';
import { type ArcadeSession, createArcadeSession, TICK_MS } from '../session';

/** Víc času najednou se zahodí, jako v relaci kola. */
const MAX_FRAME_MS = 250;

export interface ChainSession {
  readonly chain: ChainWorld;
  /** Relace kola, které se hraje; během karty a po konci ta, která skončila naposled. */
  current(): ArcadeSession;
  /** Index kola, které se hraje, nebo po kartě začne. */
  round(): number;
  /** Tiky karty, které zbývají; 0 = hraje se kolo `round()`. */
  card(): number;
  lives(): number;
  score(): number;
  /** Globální tik řetězu. */
  tick(): number;
  /** Globální tik, ve kterém začalo kolo relace `current()` (duch kola, T12). */
  start(): number;
  outcome(): ArcadeOutcome;
  results(): readonly ('won' | 'lost')[];
  /** Stisk do kola; během karty a po konci se zahodí. */
  press(buttons: number, axis?: number): void;
  /** Hodiny karty v tempu dalšího kola; kolo samo pohání jeho scéna přes `current().advance`. */
  advance(ms: number): void;
  /** Řídký záznam s globálními tiky – ten, který přehraje `replayChain`. */
  inputs(): readonly InputEvent[];
  hash(): string;
  /** Kolo 1 čeká na první dotek (`gate`); tohle ho pustí. */
  begin(): void;
  waiting(): boolean;
  subscribe(listener: () => void): () => void;
  restart(): void;
}

export interface ChainSessionOptions {
  /** Kolo 1 čeká na první dotek (`holdUntilTouch`); další kola jedou hned po kartě. */
  readonly gate?: boolean;
  /** Volby relace kola 1 – čekání na první stisk a jeho spolknutí u her na čas, jako u jedné hry. */
  readonly first?: { readonly waitForInput?: boolean; readonly swallowFirst?: boolean };
}

export function createChainSession(chain: ChainWorld, { gate = false, first = {} }: ChainSessionOptions = {}): ChainSession {
  const listeners = new Set<() => void>();
  let sessions: ArcadeSession[] = [];
  let starts: number[] = [];
  let finals: Int32Array[] = [];
  let results: ('won' | 'lost')[] = [];
  let unsubscribe: (() => void)[] = [];
  let index = 0;
  let card = 0;
  let cardStart = 0;
  let accumulator = 0;
  let lives = chain.lives;
  let score = 0;
  let outcome: ArcadeOutcome = 'running';
  let opening: (ArcadeSession & { begin(): void; waiting(): boolean }) | null = null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const current = (): ArcadeSession => sessions.at(-1)!;

  /** Konec kola podle `stepChain`: skóre, život za prohru, konec řetězu, nebo karta před dalším kolem. */
  const settle = (round: number): void => {
    if (finals.length > round) return;
    const state = sessions[round]!.state();
    const ended = outcomeOf(state);
    if (ended === 'running') return;
    const won = ended === 'won';
    results.push(won ? 'won' : 'lost');
    finals.push(Int32Array.from(state));
    score += state[HEADER.counters + COUNTER.score] as number;
    if (!won) lives -= 1;
    const last = round === chain.rounds.length - 1;
    if (lives <= 0 || (last && !won)) outcome = 'lost';
    else if (last) outcome = 'won';
    else {
      cardStart = starts[round]! + (state[HEADER.tick] as number);
      card = chain.cardTicks;
      accumulator = 0;
      index = round + 1;
    }
    notify();
  };

  const open = (round: number): void => {
    const made = createArcadeSession(roundWorld(chain, round, lives), { ...(round === 0 ? first : {}), rate: chain.rounds[round]!.rate });
    const session = round === 0 && gate ? (opening = holdUntilTouch(made)) : made;
    sessions.push(session);
    starts.push(round === 0 ? 0 : cardStart + chain.cardTicks);
    unsubscribe.push(session.subscribe(() => settle(round)));
  };

  const tick = (): number => (card > 0 ? cardStart + chain.cardTicks - card : starts.at(-1)! + (current().state()[HEADER.tick] as number));

  const reset = (): void => {
    for (const stop of unsubscribe) stop();
    sessions = [];
    starts = [];
    finals = [];
    results = [];
    unsubscribe = [];
    index = 0;
    card = 0;
    cardStart = 0;
    accumulator = 0;
    lives = chain.lives;
    score = 0;
    outcome = 'running';
    opening = null;
    open(0);
  };
  reset();

  return {
    chain,
    current,
    round: () => index,
    card: () => card,
    lives: () => lives,
    score: () => score,
    tick,
    start: () => starts.at(-1)!,
    outcome: () => outcome,
    results: () => results,
    press: (buttons, axis) => {
      if (card === 0 && outcome === 'running') current().press(buttons, axis);
    },
    advance: (ms) => {
      if (card === 0 || outcome !== 'running') return;
      accumulator += (Math.min(Math.max(ms, 0), MAX_FRAME_MS) * chain.rounds[index]!.rate) / 1000;
      // Epsilon jako v relaci kola: 30 × (1000/60) je v plovoucí čárce o chlup pod 500.
      while (card > 0 && accumulator >= TICK_MS - 1e-6) {
        accumulator -= TICK_MS;
        card -= 1;
      }
      if (card === 0) open(index);
      notify();
    },
    inputs: () => sessions.flatMap((session, round) => session.inputs().map((event) => ({ tick: starts[round]! + event.tick, buttons: event.buttons, axis: event.axis }))),
    hash: () => hashChain({ outcome, card, finals, state: current().state(), lives, score, round: index, tick: tick() }),
    begin: () => opening?.begin(),
    waiting: () => opening?.waiting() === true && sessions.length === 1,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restart: () => {
      reset();
      notify();
    },
  };
}
