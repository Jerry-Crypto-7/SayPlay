'use client';

/**
 * Scéna šipek (P66). Kostra z T2: jen podlaha s povrchem prostředí věty. Mřížku kusů se šipkami, hranice mřížky
 * na plátně pro ťuk do buňky (`data-lane-cells`, `cellAxisAt` v `../lanes/lanes-input.ts`), kameru na výšku
 * (`../portrait-first.ts`, `fitTall`) a vlastní pózu na šířku dostane od úlohy žánru (T9).
 */

import { FieldGround } from '../../look/FieldGround';
import type { WorldProps } from '../../World';

/** Kam podlaha sahá (m). */
const LAND = { x0: -20, x1: 20, z0: -20, z1: 20 } as const;

export function ArrowsScene({ scene: look }: Omit<WorldProps, 'control' | 'backdrop'>) {
  return <FieldGround look={look} area={LAND} y={-0.03} />;
}
