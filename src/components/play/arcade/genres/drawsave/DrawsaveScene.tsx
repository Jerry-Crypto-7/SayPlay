'use client';

/**
 * Scéna hry kresli a zachraň (P68, kategorie `stavba`). Kostra z P68-I T1: jen podlaha s povrchem prostředí věty.
 * Mřížku kreslení, zdi z tahu, chráněnou postavu, hrozby a kameru z boku (`side`, `P68_VIEWS`) dostane od kategorie.
 */

import { FieldGround } from '../../look/FieldGround';
import type { WorldProps } from '../../World';

/** Kam podlaha sahá (m). */
const LAND = { x0: -30, x1: 30, z0: -30, z1: 30 } as const;

export function DrawsaveScene({ scene: look }: Omit<WorldProps, 'control' | 'backdrop'>) {
  return <FieldGround look={look} area={LAND} y={-0.03} />;
}
