/**
 * Sběrnice efektů (P32-0 T5; typ `VisualEvent` drží řídicí session, zbytek P32A).
 * Z efektů jádra, které relace hlásí hře člověka (`session.onEvents`), dělá
 * vizuální události pro částice a otřes. Ukázka ani přehrání `playInputs`
 * posluchače nevolají, takže ani sběrnice nic nevydá.
 *
 * Poloha je ze stavu po tiku, který efekt vydal – z hashovaného snímku, ne
 * z interpolace kreslení; metry v osách jádra (x zrcadlí až scéna, stejně jako
 * těla). Sběrnice stav jen čte: do relace, stavu ani hashe nezapíše nic.
 *
 * Jedna událost na (tik, tělo, druh): dva zásahy téhož těla v jednom tiku jsou
 * jeden záblesk. Restart relace (tik zpět) zahodí živé částice i otřes.
 */

import { type ArcadeEffect, BODY, FLAG, HEADER, ROLE, RUN_STATE, UNIT, bodyBase, targetStateOf } from '@/play/arcade/contract';

import type { ArcadeSession } from '../session';

/**
 * `pickup` = sebraná věc zmizela, `death` = jiné tělo zmizelo, `hit` = zásah těla
 * (u hráče i ubraný život), `stateChange` = cíl přešel do jiného stavu, `spawn` =
 * nové tělo z efektu `spawn`, `win` / `lose` = konec běhu. `land` (dopad) jádro
 * jako efekt nehlásí – sběrnice ho zatím nevydá.
 */
export type VisualEventKind = 'pickup' | 'hit' | 'death' | 'win' | 'lose' | 'stateChange' | 'land' | 'spawn';

export interface VisualEvent {
  readonly kind: VisualEventKind;
  /** Index těla; výhra a prohra patří hráči. */
  readonly body: number;
  /** Role těla (`ROLE`). */
  readonly role: number;
  /** Spodní střed těla v metrech, ze stavu po tiku `tick`. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Tik, ve kterém efekt padl (jako `tick` posluchače relace). */
  readonly tick: number;
  /** Jen `stateChange`: stav cíle po tiku (0..`TARGET_STATE_MAX`). */
  readonly state?: number;
}

/** Klíč události – jeden na (tik, tělo, druh); hodí se i jako klíč částice. */
export const visualKey = (event: Pick<VisualEvent, 'tick' | 'body' | 'kind'>): string => `${event.tick}:${event.body}:${event.kind}`;

/** Jak dlouho žije částice události: 30 tiků = 0,5 s. */
export const LIVE_TICKS = 30;
/** Jak dlouho doznívá otřes po zásahu hráče: 9 tiků = 150 ms, jako třída `play-stage-shake`. */
export const SHAKE_TICKS = 9;

/** Co sběrnice z relace smí: číst stav a poslouchat. Stisknout, pozastavit ani restartovat nemůže. */
export type EffectsSource = Pick<ArcadeSession, 'onEvents' | 'subscribe' | 'state' | 'prev'>;

export interface EffectsBus {
  /** Nové události jednoho tiku, v pořadí efektů. */
  subscribe(listener: (events: readonly VisualEvent[]) => void): () => void;
  /** Události posledních `LIVE_TICKS` tiků (živé částice), nejstarší první. */
  live(): readonly VisualEvent[];
  /** Otřes 0..1: 1 hned po tiku zásahu hráče, za `SHAKE_TICKS` doběhne na 0. */
  shake(): number;
  /** Zahodí živé částice i otřes; restart relace to udělá sám. */
  reset(): void;
  /** Odpojí sběrnici od relace. */
  dispose(): void;
}

const aliveIn = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Efekty jednoho tiku → vizuální události; `state` = stav po tiku, `prev` = před ním. */
function visualEventsOf(effects: readonly ArcadeEffect[], tick: number, state: Int32Array, prev: Int32Array): VisualEvent[] {
  const player = state[HEADER.player] as number;
  const events: VisualEvent[] = [];
  const seen = new Set<string>();
  const add = (kind: VisualEventKind, body: number, targetState?: number): void => {
    const key = visualKey({ tick, body, kind });
    if (seen.has(key)) return;
    seen.add(key);
    const base = bodyBase(body);
    const at = { kind, body, role: state[base + BODY.role] as number, x: (state[base + BODY.x] as number) / UNIT, y: (state[base + BODY.y] as number) / UNIT, z: (state[base + BODY.z] as number) / UNIT, tick };
    events.push(targetState === undefined ? at : { ...at, state: targetState });
  };
  // Tělo mimo svět jádro zahodí (`apply` v `kernel.ts`), sběrnice taky.
  const inWorld = (body: number): boolean => body >= 0 && body < (state[HEADER.bodyCount] as number);
  let spawns = 0;
  for (const effect of effects) {
    if (effect.kind === 'damage') add('hit', player);
    else if (effect.kind === 'spawn') spawns += 1;
    // Jako jádro: zásah jen živého těla (před tikem – smrtící rána tělo zabije až po sobě) a jen kladný.
    else if (effect.kind === 'hit' && inWorld(effect.body) && aliveIn(prev, effect.body) && effect.amount > 0) add('hit', effect.body);
    // Jen tělo, které tímhle tikem opravdu zmizelo – despawn mrtvého těla stav nemění.
    else if (effect.kind === 'despawn' && inWorld(effect.body) && aliveIn(prev, effect.body) && !aliveIn(state, effect.body)) {
      add(state[bodyBase(effect.body) + BODY.role] === ROLE.collectible ? 'pickup' : 'death', effect.body);
    } else if (effect.kind === 'stateChange' && inWorld(effect.body) && targetStateOf(state, effect.body) !== targetStateOf(prev, effect.body)) {
      add('stateChange', effect.body, targetStateOf(state, effect.body));
    }
  }
  // Tělo z `spawn` jde do slotu od `spawnBase`, který před tikem nežil (plný svět spawn zahodí).
  if (spawns > 0) {
    for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) {
      if (!aliveIn(prev, body) && aliveIn(state, body)) add('spawn', body);
    }
  }
  // Konec podle stavu, ne podle efektu: prohra v témže tiku výhru přebije (`settleRun` v jádře).
  const run = state[HEADER.runState];
  if (run === RUN_STATE.won) add('win', player);
  else if (run === RUN_STATE.lost) add('lose', player);
  return events;
}

export function createEffectsBus(session: EffectsSource): EffectsBus {
  let live: VisualEvent[] = [];
  /** Tik posledního zásahu hráče; −1 = bez otřesu. */
  let shakeFrom = -1;
  /** Tik, na kterém relace naposled stála – když ho restart vrátí zpět, patří všechno starému běhu. */
  let seenTick = session.state()[HEADER.tick] as number;
  const listeners = new Set<(events: readonly VisualEvent[]) => void>();
  const now = (): number => session.state()[HEADER.tick] as number;
  const reset = (): void => {
    live = [];
    shakeFrom = -1;
  };

  const offEvents = session.onEvents((effects, tick) => {
    const state = session.state();
    seenTick = tick + 1;
    const events = visualEventsOf(effects, tick, state, session.prev());
    if (events.length === 0) return;
    live = live.filter((event) => tick - event.tick < LIVE_TICKS).concat(events);
    // Stav už je po tiku zásahu (`tick + 1`): odtud otřes doznívá.
    if (events.some((event) => event.kind === 'hit' && event.body === state[HEADER.player])) shakeFrom = tick + 1;
    for (const listener of listeners) listener(events);
  });
  const offState = session.subscribe(() => {
    const tick = now();
    if (tick < seenTick) reset();
    seenTick = tick;
  });

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    live: () => {
      const tick = now();
      live = live.filter((event) => tick - event.tick < LIVE_TICKS);
      return live;
    },
    shake: () => (shakeFrom < 0 ? 0 : Math.max(0, 1 - (now() - shakeFrom) / SHAKE_TICKS)),
    reset,
    dispose: () => {
      offEvents();
      offState();
      listeners.clear();
      reset();
    },
  };
}
