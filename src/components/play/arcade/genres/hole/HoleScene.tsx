'use client';

/**
 * Scéna díry (P66). Kostra z T2: jen podlaha s povrchem prostředí věty. Díru, věci z věty, pád do díry, kameru
 * na výšku (`../portrait-first.ts`, `fitTall`) a vlastní pózu na šířku dostane od úlohy žánru (T6).
 */

import { FieldGround } from '../../look/FieldGround';
import type { WorldProps } from '../../World';

/** Kam podlaha sahá (m). */
const LAND = { x0: -40, x1: 40, z0: -40, z1: 40 } as const;

export function HoleScene({ scene: look }: Omit<WorldProps, 'control' | 'backdrop'>) {
  return <FieldGround look={look} area={LAND} y={-0.03} />;
}
