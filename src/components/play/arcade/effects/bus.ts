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

import { type ArcadeEffect, type ArcadeState, BODY, COUNTER, FLAG, HEADER, type PieceRef, ROLE, RUN_STATE, UNIT, bodyBase, nativeRule, targetStateOf } from '@/play/arcade/contract';
import { type BehaviourRef, behaviourBodies, behaviourPhaseOf, shotBodies, telegraphOf } from '@/play/arcade/pieces/behaviours';
import { BOSS } from '@/play/arcade/pieces/behaviours/boss';

import { actualHitBodies } from './impact';
import type { ArcadeWorld } from '@/play/arcade/contract';
import type { ArcadeSession } from '../session';

/**
 * `pickup` = sebraná věc zmizela, `death` = jiné tělo zmizelo, `hit` = zásah těla
 * (u hráče i ubraný život), `stateChange` = cíl přešel do jiného stavu, `spawn` =
 * nové tělo z efektu `spawn`, `win` / `lose` = konec běhu. `land` (dopad hráče)
 * jádro jako efekt nehlásí – sběrnice ho pozná ze stavu (P32A T4). `nearMiss`
 * (P45C T15) taky ne: hrozba průběhu prošla kolem hráče do `NEAR_MISS` a nezasáhla.
 */
export const VISUAL_EVENT_KINDS = ['pickup', 'hit', 'death', 'win', 'lose', 'stateChange', 'land', 'spawn', 'nearMiss'] as const;
export type VisualEventKind = (typeof VISUAL_EVENT_KINDS)[number];

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
/** Jak dlouho doznívá otřes kamery po zásahu hráče: 9 tiků = 150 ms. */
export const SHAKE_TICKS = 9;

/** Co sběrnice z relace smí: číst stav a poslouchat. Stisknout, pozastavit ani restartovat nemůže. */
export type EffectsSource = Pick<ArcadeSession, 'onEvents' | 'subscribe' | 'state' | 'prev' | 'humanRun'> & { readonly world?: Pick<ArcadeWorld, 'rules'> };

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
const groundedIn = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.grounded) !== 0;

/** Událost těla `body` ze stavu po tiku `tick`. */
function eventAt(kind: VisualEventKind, body: number, tick: number, state: Int32Array): VisualEvent {
  const base = bodyBase(body);
  return { kind, body, role: state[base + BODY.role] as number, x: (state[base + BODY.x] as number) / UNIT, y: (state[base + BODY.y] as number) / UNIT, z: (state[base + BODY.z] as number) / UNIT, tick };
}

/** Efekty jednoho tiku → vizuální události; `state` = stav po tiku, `prev` = před ním. */
function visualEventsOf(effects: readonly ArcadeEffect[], tick: number, state: Int32Array, prev: Int32Array, world?: Pick<ArcadeWorld, 'rules'>): VisualEvent[] {
  const player = state[HEADER.player] as number;
  const events: VisualEvent[] = [];
  const seen = new Set<string>();
  const add = (kind: VisualEventKind, body: number, targetState?: number): void => {
    const key = visualKey({ tick, body, kind });
    if (seen.has(key)) return;
    seen.add(key);
    const at = eventAt(kind, body, tick, state);
    events.push(targetState === undefined ? at : { ...at, state: targetState });
  };
  // Tělo mimo svět jádro zahodí (`apply` v `kernel.ts`), sběrnice taky.
  const inWorld = (body: number): boolean => body >= 0 && body < (state[HEADER.bodyCount] as number);
  for (const body of actualHitBodies(effects, prev, state, world)) add('hit', body);
  let spawns = 0;
  for (const effect of effects) {
    if (effect.kind === 'spawn') spawns += 1;
    // Jako jádro: zásah jen živého těla (před tikem – smrtící rána tělo zabije až po sobě) a jen kladný.
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

/** Chování průběhu ve hře (P45C): odkazy z pravidla `pacing`; hra bez něj žádná nemá. */
export const pacingRefsOf = (rules: readonly PieceRef[]): readonly BehaviourRef[] => (nativeRule(rules, 'pacing')?.params.behaviours ?? []) as readonly BehaviourRef[];

/** Boss finále: poslední předloha chování pravidla `pacing` s finále `boss` (`withPacing`), jinak `undefined`. */
export const pacingBossOf = (rules: readonly PieceRef[]): BehaviourRef | undefined => (nativeRule(rules, 'pacing')?.params.finale === 'boss' ? pacingRefsOf(rules).at(-1) : undefined);

/** Blízké minutí: hrozba průběhu prošla kolem hráče nejvýš o tolik (1,5 m, mezera hran) a nezasáhla. */
export const NEAR_MISS = (3 * UNIT) / 2;

/** Mezera hran dvou těl na zemi (jednotky); 0 = dotýkají se. */
function edgeGap(state: ArcadeState, a: number, b: number): number {
  const pa = bodyBase(a);
  const pb = bodyBase(b);
  const gx = Math.abs((state[pa + BODY.x] as number) - (state[pb + BODY.x] as number)) - ((state[pa + BODY.w] as number) + (state[pb + BODY.w] as number)) / 2;
  const gz = Math.abs((state[pa + BODY.z] as number) - (state[pb + BODY.z] as number)) - ((state[pa + BODY.d] as number) + (state[pb + BODY.d] as number)) / 2;
  return Math.hypot(Math.max(0, gx), Math.max(0, gz));
}

/** Mezera hráče k dosahu dupnutí bosse (střed od středu, jako `boss.effects`). */
function stompGap(state: ArcadeState, boss: number, player: number): number {
  const b = bodyBase(boss);
  const p = bodyBase(player);
  return Math.max(0, Math.hypot((state[p + BODY.x] as number) - (state[b + BODY.x] as number), (state[p + BODY.z] as number) - (state[b + BODY.z] as number)) - BOSS.stomp);
}

/** Jeden průlet hrozby: nejmenší mezera, životy na jeho začátku, dupnutí (dosah kruhem) a výstřel. */
interface Pass {
  closest: number;
  readonly health: number;
  readonly shot: boolean;
  stomp: boolean;
}

export interface NearMissWatch {
  /** Stav po posledních ticích → těla, jejichž průlet skončil blízkým minutím. Stav jen čte. */
  see(state: ArcadeState): number[];
  reset(): void;
}

/**
 * Hlídka blízkých minutí (P45C T15). Hrozba = tělo chování od začátku varování
 * do konce úderu (mezera se měří v `act`) a každý výstřel chování, dokud žije.
 * Průlet skončí blízkým minutím, když nejmenší mezera byla nad 0 a nejvýš
 * `NEAR_MISS` a hráč mezitím neztratil život. Vzorkuje po oznámeních relace
 * (telefon odtiká i dva tiky za snímek): úder, který vzorkování přeskočilo
 * (dupnutí trvá tik), se změří při konci, když tělo pořád žije; tělo, které
 * zmizelo dřív, než udeřilo (úklid před poslední vlnou), nic nehlásí. Mrtvý
 * slot drží polohu z tiku zániku, takže výstřel, který hráče trefil v milosti,
 * má mezeru 0.
 */
export function createNearMissWatch(rules: readonly PieceRef[]): NearMissWatch {
  const refs = pacingRefsOf(rules);
  const bossRefs = refs.filter((ref) => ref.id === 'boss');
  const passes = new Map<number, Pass>();
  return {
    see(state) {
      if (refs.length === 0) return [];
      const player = state[HEADER.player] as number;
      const health = state[HEADER.counters + COUNTER.health] as number;
      const seen = new Set<number>();
      const open = (body: number, shot: boolean): Pass => {
        seen.add(body);
        let pass = passes.get(body);
        if (pass === undefined) passes.set(body, (pass = { closest: Infinity, health, shot, stomp: false }));
        return pass;
      };
      const bosses = bossRefs.length === 0 ? [] : behaviourBodies(state, player, bossRefs);
      for (const body of behaviourBodies(state, player, refs)) {
        const phase = behaviourPhaseOf(state, body);
        if (phase !== 'telegraph' && phase !== 'act') continue;
        const pass = open(body, false);
        // Dupnutí poznáme z varování: boss s kruhem (strážce má kruh dosahu, ale útočí výpadem).
        if (phase === 'telegraph') pass.stomp = bosses.includes(body) && telegraphOf(state, body)?.kind === 'ring';
        else pass.closest = Math.min(pass.closest, pass.stomp ? stompGap(state, body, player) : edgeGap(state, body, player));
      }
      for (const shot of shotBodies(state, player, refs)) {
        const pass = open(shot, true);
        pass.closest = Math.min(pass.closest, edgeGap(state, shot, player));
      }
      const missed: number[] = [];
      for (const [body, pass] of passes) {
        if (seen.has(body)) continue;
        passes.delete(body);
        const alive = ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
        if (!pass.shot && pass.closest === Infinity && !alive) continue;
        const end = pass.stomp ? stompGap(state, body, player) : edgeGap(state, body, player);
        const closest = pass.stomp && pass.closest !== Infinity ? pass.closest : Math.min(pass.closest, end);
        if (closest > 0 && closest <= NEAR_MISS && health >= pass.health) missed.push(body);
      }
      return missed;
    },
    reset: () => passes.clear(),
  };
}

export function createEffectsBus(session: EffectsSource): EffectsBus {
  let live: VisualEvent[] = [];
  /** Tik posledního zásahu hráče; −1 = bez otřesu. */
  let shakeFrom = -1;
  /** Tik, na kterém relace naposled stála – když ho restart vrátí zpět, patří všechno starému běhu. */
  let seenTick = session.state()[HEADER.tick] as number;
  /**
   * Hráč byl při posledním oznámení relace ve vzduchu. Dopad se pozná z příznaku
   * `grounded` mezi oznámeními, ne mezi dvěma tiky: telefon za snímek odtiká i dva.
   */
  let airborne = false;
  const nearMiss = createNearMissWatch(session.world?.rules ?? []);
  const listeners = new Set<(events: readonly VisualEvent[]) => void>();
  const now = (): number => session.state()[HEADER.tick] as number;
  const reset = (): void => {
    live = [];
    shakeFrom = -1;
    airborne = false;
    nearMiss.reset();
  };
  const publish = (events: readonly VisualEvent[], tick: number): void => {
    live = live.filter((event) => tick - event.tick < LIVE_TICKS).concat(events);
    for (const listener of listeners) listener(events);
  };

  const offEvents = session.onEvents((effects, tick) => {
    const state = session.state();
    seenTick = tick + 1;
    const events = visualEventsOf(effects, tick, state, session.prev(), session.world);
    if (events.length === 0) return;
    // Stav už je po tiku zásahu (`tick + 1`): odtud otřes doznívá.
    if (events.some((event) => event.kind === 'hit' && event.body === state[HEADER.player])) shakeFrom = tick + 1;
    publish(events, tick);
  });
  const offState = session.subscribe(() => {
    const tick = now();
    if (tick < seenTick) reset();
    seenTick = tick;
    const state = session.state();
    const player = state[HEADER.player] as number;
    const grounded = groundedIn(state, player);
    // Jako ostatní události jen za člověka: ukázka ani přehrání záznamu nic nevydají.
    if (airborne && grounded && session.humanRun()) publish([eventAt('land', player, tick - 1, state)], tick - 1);
    airborne = !grounded && aliveIn(state, player);
    // Blízké minutí (P45C T15): hlídka sleduje průlety vždy, vydá je jen hra člověka.
    const missed = nearMiss.see(state);
    if (missed.length > 0 && session.humanRun()) publish(missed.map((body) => eventAt('nearMiss', body, tick - 1, state)), tick - 1);
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
