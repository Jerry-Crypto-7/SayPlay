/**
 * Časová osa nad běžícím světem: kruhový buffer snímků plus kotva.
 *
 * Snímek je **všechno, co přes hranici tiku nese informaci** — ne jen zabalený
 * stav. Kdyby nesl jen `state`, obnovení by zapomnělo frontu a pozorování
 * minulého tiku, a hrana `onEdge` se počítá právě proti nim: běh po skoku by se
 * rozešel s během bez skoku, přestože by hash stavu v okamžiku skoku seděl.
 *
 * **Kruh sám nestačí a kotva není přílepek.** Kruh drží posledních `capacity`
 * tiků, takže skok o pár vteřin zpět je jedna kopie pole. Skok na začátek
 * dvousetkového běhu ale míří na tik, který už kruh dávno přepsal — bez kotvy by
 * byl nedosažitelný a „přetočit čas" by platilo jen pro nedávnou minulost.
 * Kotva je snímek tiku, ve kterém osa vznikla, a nepřepisuje se nikdy.
 */

import type { Observation } from '../ir/eval';
import {
  step,
  type FaultReason,
  type RunState,
  type Runtime,
  type StepResult,
  type TraceInput,
} from './interpreter';

/**
 * Dvě mutovatelná pole runtimu tu schválně **nejsou**, a obě vypadají, že by tam
 * patřit měla:
 *
 * - `writeQueue` je na hranici tiku vždycky prázdná. `step` ji na konci prohodí
 *   do `drainQueue` a vyprázdní, atomicky přerušený tik ji vyprázdní taky. Není
 *   to předpoklad — drží ho aserce v testu osy, takže se změna interpretu ozve
 *   tady, ne až v demu.
 * - `budget.remaining` se na začátku každého tiku resetuje, takže hodnota
 *   z minulého tiku nemá na trajektorii žádný vliv.
 *
 * Nosit je by nebyla úplnost, ale dvě pole, o kterých nejde dokázat, že něco
 * chrání — a mutace, která je zahodí, by musela projít.
 */
export interface Snapshot {
  /** Tik, který runtime v tomhle snímku teprve **odkrokuje**. */
  readonly tick: number;
  readonly state: Uint32Array;
  readonly runState: RunState;
  readonly fault: FaultReason | null;
  readonly drainQueue: readonly string[];
  readonly previous: Observation;
}

export interface Timeline {
  readonly capacity: number;
  /** Snímek tiku, ve kterém osa začala. Jediný, který kruh nikdy nepřepíše. */
  readonly anchor: Snapshot;
  readonly ring: Snapshot[];
  /** Kolik snímků kruhem celkem prošlo. Živých je `min(written, capacity)`. */
  written: number;
}

/**
 * Kopie je hluboká na obou koncích, a to ze dvou různých důvodů.
 *
 * Při ukládání: `writeSlot` píše do `runtime.state` na místě, takže sdílený
 * buffer by se s každým dalším tikem tiše přepsal a snímek by popisoval
 * přítomnost, ne minulost. Při obnovení: bez kopie by běh po skoku přepsal
 * samotný snímek, takže druhý skok na týž tik by skončil jinde než první.
 */
function capture(runtime: Runtime): Snapshot {
  return {
    tick: runtime.tick,
    state: runtime.state.slice(),
    runState: runtime.runState,
    fault: runtime.fault,
    drainQueue: runtime.drainQueue.slice(),
    // `sense()` vyrábí nové pozorování každý tik a `previous` se výhradně
    // přiřazuje, nikdy nepřepisuje na místě — sdílená reference je tu proto
    // bezpečná a hluboká kopie sad by byla čistá cena.
    previous: runtime.previous,
  };
}

function restore(runtime: Runtime, snapshot: Snapshot): void {
  runtime.state = snapshot.state.slice();
  runtime.runState = snapshot.runState;
  runtime.fault = snapshot.fault;
  runtime.tick = snapshot.tick;
  runtime.drainQueue = snapshot.drainQueue.slice();
  runtime.previous = snapshot.previous;
}

/**
 * `capacity` je počet tiků, na které se skáče lacino. Nula by z indexu do kruhu
 * udělala `NaN` a zápis by tiše zmizel do vlastnosti objektu, takže se odmítá na
 * hranici — je to číslo od volajícího, ne vnitřní konstanta.
 */
export function createTimeline(runtime: Runtime, capacity: number): Timeline {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`timeline capacity must be a positive integer, got ${capacity}`);
  }
  return { capacity, anchor: capture(runtime), ring: [], written: 0 };
}

function record(timeline: Timeline, runtime: Runtime): void {
  timeline.ring[timeline.written % timeline.capacity] = capture(runtime);
  timeline.written += 1;
}

/**
 * Odkrokuje jeden tik a zapíše snímek stavu, do kterého se tím došlo.
 *
 * Tik, který runtimem nepohnul (běh už skončil), se nezapisuje. Jinak by
 * dopočítávání do konce u dohraného světa naplnilo kruh kopiemi téhož tiku
 * a vytlačilo z něj celou minulost, kterou má osa nabízet.
 */
export function advance(timeline: Timeline, runtime: Runtime, inputs: readonly TraceInput[]): StepResult {
  const before = runtime.tick;
  const result = step(runtime, inputs);
  if (runtime.tick !== before) record(timeline, runtime);
  return result;
}

/** Nejnovější snímek, který neleží za cílem. Kotva je vždycky poslední záchrana. */
function baseFor(timeline: Timeline, tick: number): Snapshot {
  let best = timeline.anchor;
  const live = Math.min(timeline.written, timeline.capacity);
  for (let i = 0; i < live; i += 1) {
    const snapshot = timeline.ring[i];
    if (snapshot.tick <= tick && snapshot.tick > best.tick) best = snapshot;
  }
  return best;
}

function replayTo(runtime: Runtime, tick: number): void {
  while (runtime.tick < tick && runtime.runState === 'running') {
    const current = runtime.tick;
    step(
      runtime,
      runtime.doc.trace.filter((entry) => entry.tick === current),
    );
  }
}

/**
 * Postaví runtime na `tick` a vrátí tik, na kterém skutečně stojí.
 *
 * Dopředu se jde krokováním z přítomnosti, dozadu obnovením nejbližšího snímku
 * a dopočítáním. Vrácený tik se od žádaného liší jen tam, kde se žádaný nedá
 * dosáhnout — cíl před kotvou, nebo běh, který skončil dřív. Osa v takovém
 * případě mlčky nepřistane jinde: řekne kam.
 *
 * Kruh se při přetáčení **nepřepisuje**. Snímky, které leží za cílem, jsou pořád
 * platný popis té budoucnosti, a zahodit je by znamenalo, že scrub tam a zpátky
 * pokaždé přepočítá totéž.
 */
export function seekTo(timeline: Timeline, runtime: Runtime, tick: number): number {
  if (tick <= runtime.tick) restore(runtime, baseFor(timeline, tick));
  replayTo(runtime, tick);
  return runtime.tick;
}
