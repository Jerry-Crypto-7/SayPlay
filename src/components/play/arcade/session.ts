/**
 * Relace arkádové hry v prohlížeči (P25A T6): stav, záznam vstupů, pevný krok.
 *
 * Hodiny jen pohánějí tiky – `advance(ms)` přičte čas do akumulátoru a
 * odtiká celé kroky po 1/60 s; stav se počítá jen ze světa a vstupů, takže
 * záznam (`inputs()`) přehraný `replay` z jádra dá týž hash. Stisky mezi
 * tiky se sbírají do masky a padnou do nejbližšího tiku (hrany); osa
 * (`hold`, plošinovka P25C) platí, dokud se nezmění, a zapisuje se do
 * každého tiku, kdy je nenulová. `prev` je stav před posledním krokem –
 * kreslení mezi ním a `state` interpoluje.
 */

import { ARCADE_HZ, AXIS_MAX, type ArcadeWorld, COUNTER, HEADER, type InputEvent, NO_INPUT, UNIT, bodyBase, BODY } from '@/play/arcade/contract';
import { type ArcadeOutcome, instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { runBot } from '@/play/arcade/verify';

export const TICK_MS = 1000 / ARCADE_HZ;
/** Víc času najednou (skrytá záložka, zamrzlý snímek) se zahodí – hra se nedohraje bez hráče. */
const MAX_FRAME_MS = 250;

export interface ArcadeSnapshot {
  readonly tick: number;
  readonly runState: ArcadeOutcome;
  readonly score: number;
  readonly health: number;
  /** Uběhlá část trati 0..100 (%). */
  readonly progress: number;
  readonly distanceM: number;
}

export interface ArcadeSession {
  readonly world: ArcadeWorld;
  state(): Int32Array;
  prev(): Int32Array;
  press(buttons: number): void;
  /** Držená osa −AXIS_MAX..AXIS_MAX (0 = puštěno). */
  hold(axis: number): void;
  /** Posune hodiny o `ms`; vrací podíl rozběhnutého tiku 0..1 pro interpolaci. */
  advance(ms: number): number;
  stepOnce(): void;
  inputs(): readonly InputEvent[];
  snapshot(): ArcadeSnapshot;
  subscribe(listener: () => void): () => void;
  restart(): void;
  /** Od tiku 0 přehraje záznam a dotočí běh do konce (nebo horizontu). */
  playInputs(inputs: readonly InputEvent[], horizon: number): ArcadeSnapshot;
  /** Záznam robota ověřovače – ten, kterým hra prošla publikací. */
  botInputs(): readonly InputEvent[];
}

/**
 * `waitForInput`: hodiny stojí až do prvního stisku (poletování – ptáček by
 * jinak spadl dřív, než hráč hru uvidí). První stisk padne do tiku 0, takže
 * záznam i přehrání jsou tytéž jako bez čekání.
 */
export function createArcadeSession(world: ArcadeWorld, { waitForInput = false }: { readonly waitForInput?: boolean } = {}): ArcadeSession {
  const program = loadProgram(world, ARCADE_LIBRARY);
  let state = instantiate(world);
  let prev = Int32Array.from(state);
  let log: InputEvent[] = [];
  let pending = 0;
  let held = 0;
  let started = !waitForInput;
  let accumulator = 0;
  let cached: ArcadeSnapshot | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    cached = null;
    for (const listener of listeners) listener();
  };

  const tickOnce = (buttons: number, axis: number): void => {
    if (outcomeOf(state) !== 'running') return;
    prev.set(state);
    const tick = state[HEADER.tick] as number;
    if (buttons === 0 && axis === 0) step(state, NO_INPUT, program);
    else {
      log.push({ tick, buttons, axis });
      step(state, { buttons, axis }, program);
    }
  };

  const session: ArcadeSession = {
    world,
    state: () => state,
    prev: () => prev,
    press: (buttons) => {
      pending |= buttons;
      if (buttons !== 0) started = true;
    },
    hold: (axis) => {
      held = Math.max(-AXIS_MAX, Math.min(AXIS_MAX, Math.trunc(axis)));
      if (held !== 0) started = true;
    },
    advance: (ms) => {
      if (outcomeOf(state) !== 'running') return 1;
      if (!started) return 0;
      accumulator += Math.min(Math.max(ms, 0), MAX_FRAME_MS);
      let stepped = false;
      // Epsilon: 30 × (1000/60) v plovoucí čárce je o chlup pod 500 a tik by se ztratil.
      while (accumulator >= TICK_MS - 1e-6 && outcomeOf(state) === 'running') {
        accumulator -= TICK_MS;
        tickOnce(pending, held);
        pending = 0;
        stepped = true;
      }
      if (stepped) notify();
      return Math.min(1, accumulator / TICK_MS);
    },
    stepOnce: () => {
      tickOnce(pending, held);
      pending = 0;
      notify();
    },
    inputs: () => log,
    snapshot: () => {
      if (cached !== null) return cached;
      const player = bodyBase(state[HEADER.player] as number);
      const z = Math.max(0, state[player + BODY.z] as number);
      const runState = outcomeOf(state);
      cached = {
        tick: state[HEADER.tick] as number,
        runState,
        score: state[HEADER.counters + COUNTER.score] as number,
        health: state[HEADER.counters + COUNTER.health] as number,
        // Cílová páska se protne přední stěnou, ne středem – výhra je vždy celá trať.
        progress: runState === 'won' ? 100 : world.length > 0 ? Math.min(99, Math.floor((z * 100) / world.length)) : 0,
        distanceM: Math.floor(z / UNIT),
      };
      return cached;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restart: () => {
      state = instantiate(world);
      prev = Int32Array.from(state);
      log = [];
      pending = 0;
      held = 0;
      started = !waitForInput;
      accumulator = 0;
      notify();
    },
    playInputs: (inputs, horizon) => {
      session.restart();
      let next = 0;
      while (outcomeOf(state) === 'running' && (state[HEADER.tick] as number) < horizon) {
        const tick = state[HEADER.tick] as number;
        while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
        const event = inputs[next];
        const now = event !== undefined && event.tick === tick ? event : NO_INPUT;
        tickOnce(now.buttons, now.axis);
      }
      notify();
      return session.snapshot();
    },
    botInputs: () => runBot(world).inputs,
  };
  return session;
}
