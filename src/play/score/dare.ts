/**
 * Záznam vstupů pro výzvu Dare (P36B T5) ve zhuštěném tvaru a jeho kontrola.
 *
 * Dveře mají strop těla 64 kB (`src/http/body.ts`) a relace zapisuje držená
 * osa a tlačítka do **každého** tiku – 90 s držené šipky jako JSON
 * `InputEvent[]` je ~200 kB. Proto běhy: ploché čtveřice
 * `[mezera, délka, tlačítka, osa]`, kde mezera je počet tiků bez vstupu od
 * konce předchozího běhu a délka počet po sobě jdoucích tiků se stejným
 * vstupem. Držení je jedna čtveřice; nejhorší případ (jiná osa každý tik)
 * vyjde na ~60 kB.
 *
 * `unpackInputs` je kontrola na hranici: vstup přichází od cizího klienta.
 */

import { ARCADE_LIMITS, AXIS_MAX, AXIS_MIN, BUTTON, type InputEvent } from '@/play/arcade/contract';

/** Všechny bity tlačítek, které jádro zná. */
const BUTTON_MASK = Object.values(BUTTON).reduce((mask, bit) => mask | bit, 0);

export function packInputs(inputs: readonly InputEvent[]): number[] {
  const packed: number[] = [];
  let end = 0;
  let run: { start: number; length: number; buttons: number; axis: number } | null = null;
  const flush = (): void => {
    if (run === null) return;
    packed.push(run.start - end, run.length, run.buttons, run.axis);
    end = run.start + run.length;
  };
  for (const event of inputs) {
    if (run !== null && event.tick === run.start + run.length && event.buttons === run.buttons && event.axis === run.axis) {
      run.length += 1;
      continue;
    }
    flush();
    run = { start: event.tick, length: 1, buttons: event.buttons, axis: event.axis };
  }
  flush();
  return packed;
}

const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/** Rozbalí a zkontroluje běhy; řetězec = proč záznam neplatí. Výsledek je seřazený podle tiku. */
export function unpackInputs(packed: unknown): InputEvent[] | string {
  if (!Array.isArray(packed) || packed.length % 4 !== 0) return 'inputs must be a flat list of [gap, length, buttons, axis] runs';
  if (packed.length > 4 * ARCADE_LIMITS.maxTicks) return `at most ${String(ARCADE_LIMITS.maxTicks)} input runs`;
  const events: InputEvent[] = [];
  let tick = 0;
  for (let i = 0; i < packed.length; i += 4) {
    const [gap, length, buttons, axis] = packed.slice(i, i + 4) as unknown[];
    if (!whole(gap) || !whole(length) || !whole(buttons) || !whole(axis)) return 'every input value must be a whole number';
    if (gap < 0 || length < 1) return 'input runs need a gap of 0 or more and a length of 1 or more';
    if (buttons < 0 || (buttons & ~BUTTON_MASK) !== 0) return 'unknown input buttons';
    if (axis < AXIS_MIN || axis > AXIS_MAX) return `input axis must be ${String(AXIS_MIN)} to ${String(AXIS_MAX)}`;
    tick += gap;
    if (tick + length > ARCADE_LIMITS.maxTicks) return `the run is longer than ${String(ARCADE_LIMITS.maxTicks)} ticks`;
    for (let k = 0; k < length; k += 1) events.push({ tick: tick + k, buttons, axis });
    tick += length;
  }
  return events;
}
