'use client';

/**
 * Scéna přežití ve vlnách (P66). Kostra z T2: jen podlaha s povrchem prostředí věty. Hrdinu, vlny, bosse, kameru
 * na výšku (`../portrait-first.ts`, `fitTall`) a vlastní pózu na šířku dostane od úlohy žánru (T5).
 */

import { FieldGround } from '../../look/FieldGround';
import type { WorldProps } from '../../World';

/** Kam podlaha sahá (m). */
const LAND = { x0: -30, x1: 30, z0: -30, z1: 30 } as const;

export function SurvivorScene({ scene: look }: Omit<WorldProps, 'control' | 'backdrop'>) {
  return <FieldGround look={look} area={LAND} y={-0.03} />;
}
