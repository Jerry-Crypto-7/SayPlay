'use client';

/**
 * Scéna krádeže (P66). Kostra z T2: jen podlaha s povrchem prostředí věty. Obě základny, kořist, strážce, kameru
 * na výšku (`../portrait-first.ts`, `fitTall`) a vlastní pózu na šířku dostane od úlohy žánru (T7).
 */

import { FieldGround } from '../../look/FieldGround';
import type { WorldProps } from '../../World';

/** Kam podlaha sahá (m). */
const LAND = { x0: -30, x1: 30, z0: -40, z1: 40 } as const;

export function StealScene({ scene: look }: Omit<WorldProps, 'control' | 'backdrop'>) {
  return <FieldGround look={look} area={LAND} y={-0.03} />;
}
