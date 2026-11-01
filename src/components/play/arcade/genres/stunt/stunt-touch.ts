/**
 * Palec závodu s triky (P68V T4) – čistá vrstva bez DOM: gesta → `ArcadeInput`, tentýž vstup jako klávesnice řízení
 * (`steer/drive-input.ts`: šipky / A-D = osa ±`AXIS_MAX`, S / ↓ = `BUTTON.DOWN`). Tenkou komponentu nad ní dělá
 * `StuntTouch.tsx`.
 *
 * - **Tah** prstem vlevo / vpravo kdekoli ve spodní polovině plochy (`steer`): osa podle vzdálenosti od místa stisku;
 *   pod mrtvou zónou `deadPx` nula, plná po `fullPx` (jako `DRAG_PX` řízení). Řídí první prst na ploše – druhý mu
 *   osu nevezme, a když první pustí, řídí ten další od svého místa stisku.
 * - **Brzda** (`brake`): `BUTTON.DOWN`, dokud ji drží aspoň jeden prst; s tahem naráz = šipka a ↓ naráz. Prst na brzdě
 *   neřídí, ani když sjede do strany.
 */

import { AXIS_MAX, type ArcadeInput, BUTTON, NO_INPUT } from '@/play/arcade/contract';

export const STUNT_TOUCH = {
  /** Tah do tolika px je osa 0 – chvění palce neřídí. */
  deadPx: 12,
  /** Plná osa od tolika px tahu. */
  fullPx: 90,
} as const;

export type StuntTouchZone = 'steer' | 'brake';

/** Osa z tahu `dragPx` od místa stisku (celé číslo −AXIS_MAX..AXIS_MAX). */
export function stuntAxis(dragPx: number): number {
  const { deadPx, fullPx } = STUNT_TOUCH;
  const reach = Math.abs(dragPx);
  const axis = reach <= deadPx ? 0 : Math.round(Math.min(1, (reach - deadPx) / (fullPx - deadPx)) * AXIS_MAX);
  // Bez záporné nuly: záznam by ji nenesl a porovnání s klávesnicí (0) by nesedělo.
  return axis === 0 ? 0 : Math.sign(dragPx) * axis;
}

/** Opak `stuntAxis`: tah (px), který dá osu `axis` – prst e2e podle `botWants` sondy (T5). */
export function stuntDragPx(axis: number): number {
  if (axis === 0) return 0;
  const { deadPx, fullPx } = STUNT_TOUCH;
  return Math.sign(axis) * (deadPx + (Math.min(AXIS_MAX, Math.abs(axis)) / AXIS_MAX) * (fullPx - deadPx));
}

export interface StuntTouch {
  /** Prst `id` se dotkl zóny `zone` ve vodorovné poloze `x` (px). */
  down(id: number, x: number, zone: StuntTouchZone): void;
  move(id: number, x: number): void;
  up(id: number): void;
  /** Pustí všechny prsty (ztráta fokusu, odpojení). */
  clear(): void;
  /** Drží se nějaký prst? */
  active(): boolean;
  input(): ArcadeInput;
}

export function stuntTouch(): StuntTouch {
  const fingers = new Map<number, { readonly zone: StuntTouchZone; readonly from: number; x: number }>();
  return {
    down: (id, x, zone) => {
      if (!fingers.has(id)) fingers.set(id, { zone, from: x, x });
    },
    move: (id, x) => {
      const finger = fingers.get(id);
      if (finger !== undefined) finger.x = x;
    },
    up: (id) => {
      fingers.delete(id);
    },
    clear: () => fingers.clear(),
    active: () => fingers.size > 0,
    input: () => {
      if (fingers.size === 0) return NO_INPUT;
      let steer: { readonly from: number; readonly x: number } | undefined;
      let brake = false;
      for (const finger of fingers.values()) {
        if (finger.zone === 'brake') brake = true;
        else steer ??= finger;
      }
      return { axis: steer === undefined ? 0 : stuntAxis(steer.x - steer.from), buttons: brake ? BUTTON.DOWN : 0 };
    },
  };
}
