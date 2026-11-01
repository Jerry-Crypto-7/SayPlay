'use client';

/**
 * Scéna minigolfu (P68, kategorie `vozidla-sport`). Kostra z P68-I T1: jen podlaha s povrchem prostředí věty.
 * Dráhy, míček, jamku a kameru přes rameno nebo shora (`shoulder`, `top`, `P68_VIEWS`) dostane od kategorie.
 */

import { FieldGround } from '../../look/FieldGround';
import type { WorldProps } from '../../World';

/** Kam podlaha sahá (m). */
const LAND = { x0: -30, x1: 30, z0: -30, z1: 30 } as const;

export function MinigolfScene({ scene: look }: Omit<WorldProps, 'control' | 'backdrop'>) {
  return <FieldGround look={look} area={LAND} y={-0.03} />;
}
