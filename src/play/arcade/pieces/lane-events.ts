/**
 * Události pruhových žánrů (P55 T5): každé ~2 s něco k reakci a stupňování do finále. Slepý soud P54C řekl o
 * pruhových hrách „prázdné pole, cíle bliknou, málo stupňování“ – tahle vrstva jim dává tři druhy událostí:
 *
 * - **série** – 3–5 bonusových cílů rychle za sebou v sousedních pruzích;
 * - **zlatý cíl** – jeden bonus za víc bodů s kratším oknem;
 * - **spěch** – 5 s, kdy do každé mezery přibude bonus; ohlásí se, a jednou, v poslední třetině.
 *
 * Plán je jen časová osa (kdy a jaká událost); co událost ve hře je, rozhoduje žánr. Bonus se do cíle hry
 * nepočítá, takže hra hustne, ale nezkracuje se. Plán tahá jen z vlastního streamu (`spawn` se solí), nikdy
 * z času – stejné semínko dá stejný plán a rozvržení úrovně se losem událostí nepohne.
 *
 * Značka události jde do HP těla (`EVENT_MARK`, bity HP ve `flags`, tedy v hashovaném stavu): pravidlo žánru
 * podle ní pozná bonus a scéna ohlášení.
 */

import { createCompileRng } from '@/play/compile/rng';

export type LaneEventKind = 'series' | 'golden' | 'rush';

/** Značka bonusu v HP těla; 0 = běžný cíl žánru. */
export const EVENT_MARK = { series: 1, rush: 2, golden: 3 } as const satisfies Record<LaneEventKind, number>;

export const eventOfMark = (hp: number): LaneEventKind | null => (hp === EVENT_MARK.series ? 'series' : hp === EVENT_MARK.rush ? 'rush' : hp === EVENT_MARK.golden ? 'golden' : null);

export const LANE_EVENTS = {
  /** První událost (tiky): do 10 s od startu, ať hra hned ukáže, co umí. */
  first: [240, 420],
  /** Rozestup začátků událostí (tiky). */
  every: [300, 420],
  /** Velikost série. */
  series: [3, 5],
  /** Délka spěchu (tiky). */
  rushTicks: 300,
  /** Násobek bodů zlatého cíle. */
  goldenPoints: 3,
} as const;

export interface LaneEvent {
  readonly kind: LaneEventKind;
  /** Tik začátku; spěch trvá do `until`, série a zlatý cíl jsou jedno místo na ose. */
  readonly at: number;
  readonly until: number;
}

const SALT = 0x1a4e;

/**
 * Časová osa událostí pro hru dlouhou `length` tiků: série a zlaté cíle (dvě série na jeden zlatý) a jeden
 * spěch, který začne v poslední třetině a skončí před koncem.
 */
export function planLaneEvents(seed: number, length: number): LaneEvent[] {
  const rng = createCompileRng(seed ^ SALT, 'spawn');
  const rushAt = Math.max(Math.round((2 * length) / 3), 0);
  const events: LaneEvent[] = [];
  let rushed = false;
  for (let at = rng.int(...LANE_EVENTS.first); at < length; at += rng.int(...LANE_EVENTS.every)) {
    if (!rushed && at >= rushAt) {
      rushed = true;
      events.push({ kind: 'rush', at, until: at + LANE_EVENTS.rushTicks });
      at += LANE_EVENTS.rushTicks;
      continue;
    }
    const kind = rng.int(0, 2) === 0 ? 'golden' : 'series';
    events.push({ kind, at, until: at });
  }
  return events;
}

/** Čtení osy během stavby úrovně: událost, která na tik `tick` čeká (každá jednou), a zda tik leží ve spěchu. */
export function laneEventCursor(events: readonly LaneEvent[]) {
  let next = 0;
  return {
    /** Série nebo zlatý cíl, jehož čas už nastal a ještě se nepoužil. */
    take(tick: number): LaneEvent | null {
      while (next < events.length && (events[next] as LaneEvent).kind === 'rush' && (events[next] as LaneEvent).until <= tick) next += 1;
      const event = events[next];
      if (event === undefined || event.kind === 'rush' || event.at > tick) return null;
      next += 1;
      return event;
    },
    inRush: (tick: number): boolean => events.some((event) => event.kind === 'rush' && event.at <= tick && tick < event.until),
  };
}

/** Stream bonusů žánru (pruhy, rozestupy): oddělený od plánu i od rozvržení. */
export const laneEventRng = (seed: number) => createCompileRng(seed ^ SALT ^ 0x5eed, 'spawn');

/** Další pruh série: o jeden blíž k `toward`, a když v něm už je, o jeden stranou (v mezích pěti pruhů). */
export function stepLane(lane: number, toward: number, count: number, rng: { int(from: number, to: number): number }): number {
  if (toward !== lane) return lane + Math.sign(toward - lane);
  if (lane === 0) return 1;
  if (lane === count - 1) return lane - 1;
  return lane + (rng.int(0, 1) === 0 ? -1 : 1);
}
