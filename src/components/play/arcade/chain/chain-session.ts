/**
 * Relace řetězu mikroher v prohlížeči (P56C T11): jedna `ArcadeSession` na kolo, mezi koly karta se slovesem.
 *
 * Kolo hraje obyčejná relace arkády, takže scéna, vstupy i HUD kola jsou tytéž jako u jedné hry a jeho hodiny
 * pohání jeho scéna. Relace řetězu jen skládá: kolo r začne v globálním tiku `starts[r]` a jeho místní tik t je
 * globální `starts[r] + t`; po konci kola běží `cardTicks` tiků karty, během nichž žádná relace kola neběží a
 * stisky se zahodí. Skóre a hash `chain-v1` počítá týmiž pravidly jako `stepChain` (`src/play/chain/run.ts`),
 * takže `replayChain(chain, inputs())` dá týž hash.
 *
 * P70A T3: s `gate` čeká na první dotek každé kolo, ne jen první – svět kola stojí, dokud se hráč nedotkne. Čekání
 * je mimo tiky, záznam ani hash ho nevidí. Prohrané kolo řetěz zastaví; `restart` („Try again“) ho hraje znovu a
 * vyhraná kola i jejich záznam nechá, takže záznam je dál přehratelný od tiku 0.
 */

import { type ArcadeWorld, COUNTER, HEADER, type InputEvent } from '@/play/arcade/contract';
import { type ArcadeOutcome, outcomeOf } from '@/play/arcade/kernel';
import type { ChainWorld } from '@/play/chain/contract';
import { hashChain, roundWorld } from '@/play/chain/run';

import { holdUntilTouch, type ReadyGate } from '../ready-gate';
import { type ArcadeSession, createArcadeSession, TICK_MS } from '../session';

/** Víc času najednou se zahodí, jako v relaci kola. */
const MAX_FRAME_MS = 250;

export interface ChainSession {
  readonly chain: ChainWorld;
  /** Světy kol, jak je relace hraje (`roundWorld`, životy kola) – terén běžce se staví předem pro tytéž objekty. */
  readonly worlds: readonly ArcadeWorld[];
  /** Relace kola, které se hraje; během karty a po konci ta, která skončila naposled. */
  current(): ArcadeSession;
  /** Index kola, které se hraje, nebo po kartě začne. */
  round(): number;
  /** Tiky karty, které zbývají; 0 = hraje se kolo `round()`. */
  card(): number;
  /** Životy kola relace `current()` – každé kolo začne s `chain.lives`. */
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
  /** Hodiny karty; kolo samo pohání jeho scéna přes `current().advance`. */
  advance(ms: number): void;
  /** Řídký záznam s globálními tiky – ten, který přehraje `replayChain`. */
  inputs(): readonly InputEvent[];
  hash(): string;
  /** Kolo čeká na první dotek (`gate`); tohle ho pustí. */
  begin(): void;
  waiting(): boolean;
  subscribe(listener: () => void): () => void;
  /** Po prohře „Try again“: znovu prohrané kolo, vyhraná kola zůstanou. Jinak celý řetěz od kola 1. */
  restart(): void;
}

export interface ChainSessionOptions {
  /** Každé kolo čeká na první dotek (`holdUntilTouch`), i po kartě. */
  readonly gate?: boolean;
  /** Volby relace kola podle jeho světa – čekání na první stisk a jeho spolknutí u her na čas, jako u jedné hry. */
  readonly startOf?: (world: ArcadeWorld) => { readonly waitForInput?: boolean; readonly swallowFirst?: boolean };
}

export function createChainSession(chain: ChainWorld, { gate = false, startOf = () => ({}) }: ChainSessionOptions = {}): ChainSession {
  const listeners = new Set<() => void>();
  const worlds = chain.rounds.map((round) => roundWorld(round.world, chain.lives));
  let sessions: ArcadeSession[] = [];
  let starts: number[] = [];
  let finals: Int32Array[] = [];
  let results: ('won' | 'lost')[] = [];
  let unsubscribe: (() => void)[] = [];
  let index = 0;
  let card = 0;
  let cardStart = 0;
  let accumulator = 0;
  let score = 0;
  let outcome: ArcadeOutcome = 'running';
  let opening: (ArcadeSession & ReadyGate) | null = null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const current = (): ArcadeSession => sessions.at(-1)!;

  /** Konec kola podle `stepChain`: skóre, prohrané kolo zastaví řetěz, poslední vyhrané ho vyhraje, jinak karta. */
  const settle = (round: number): void => {
    if (finals.length > round) return;
    const state = sessions[round]!.state();
    const ended = outcomeOf(state);
    if (ended === 'running') return;
    const won = ended === 'won';
    results.push(won ? 'won' : 'lost');
    finals.push(Int32Array.from(state));
    score += state[HEADER.counters + COUNTER.score] as number;
    const last = round === chain.rounds.length - 1;
    if (!won) outcome = 'lost';
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
    const world = worlds[round]!;
    const made = createArcadeSession(world, startOf(world));
    const session = gate ? (opening = holdUntilTouch(made)) : made;
    sessions.push(session);
    starts.push(round === 0 ? 0 : cardStart + chain.cardTicks);
    unsubscribe.push(session.subscribe(() => settle(round)));
  };

  /** „Try again“: prohrané kolo `index` zahodí (relaci, konečný stav, výsledek i jeho skóre) a otevře ho znovu v témž tiku. */
  const retry = (): void => {
    unsubscribe.pop()!();
    sessions.pop();
    starts.pop();
    score -= finals.pop()![HEADER.counters + COUNTER.score] as number;
    results.pop();
    outcome = 'running';
    open(index);
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
    score = 0;
    outcome = 'running';
    opening = null;
    open(0);
  };
  reset();

  return {
    chain,
    worlds,
    current,
    round: () => index,
    card: () => card,
    lives: () => current().state()[HEADER.counters + COUNTER.health] as number,
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
      accumulator += Math.min(Math.max(ms, 0), MAX_FRAME_MS);
      // Epsilon jako v relaci kola: 30 × (1000/60) je v plovoucí čárce o chlup pod 500.
      while (card > 0 && accumulator >= TICK_MS - 1e-6) {
        accumulator -= TICK_MS;
        card -= 1;
      }
      if (card === 0) open(index);
      notify();
    },
    inputs: () => sessions.flatMap((session, round) => session.inputs().map((event) => ({ tick: starts[round]! + event.tick, buttons: event.buttons, axis: event.axis }))),
    hash: () => hashChain({ outcome, card, finals, state: current().state(), score, round: index, tick: tick() }),
    begin: () => opening?.begin(),
    // Během karty je `opening` relace skončeného kola, a ta už nečeká.
    waiting: () => opening?.waiting() === true,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restart: () => {
      if (outcome === 'lost') retry();
      else reset();
      notify();
    },
  };
}
