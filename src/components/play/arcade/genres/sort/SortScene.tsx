'use client';

/**
 * Scéna třídění (P66). Kostra z T2: jen podlaha s povrchem prostředí věty. Fronty, nádoby a odkladiště,
 * hranice sloupců pro vstup pruhů (`data-lane-edges`), kameru na výšku (`../portrait-first.ts`, `fitTall`)
 * a vlastní pózu na šířku dostane od úlohy žánru (T8).
 */

import { FieldGround } from '../../look/FieldGround';
import type { WorldProps } from '../../World';

/** Kam podlaha sahá (m). */
const LAND = { x0: -20, x1: 20, z0: -20, z1: 20 } as const;

export function SortScene({ scene: look }: Omit<WorldProps, 'control' | 'backdrop'>) {
  return <FieldGround look={look} area={LAND} y={-0.03} />;
}
