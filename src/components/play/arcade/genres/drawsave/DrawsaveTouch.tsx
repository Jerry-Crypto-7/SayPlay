'use client';

/**
 * Dotykový adaptér hry kresli a zachraň (P68, kategorie `stavba`). Kostra z P68-I T1: nic nekreslí ani neposílá.
 * Kategorie ho naplní: tah prstu posílá buňku mřížky v ose (`cellAxisAt`) a po dobu tahu drží `HOLD`
 * (`DRAWSAVE_STROKE` v `genre/p68-contract.ts`), jen přes `session.press` / `session.hold`.
 */

import type { GenreTouchProps } from '../touch-registry';

export function DrawsaveTouch(_props: GenreTouchProps) {
  return null;
}
