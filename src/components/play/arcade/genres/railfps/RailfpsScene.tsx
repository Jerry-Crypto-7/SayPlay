'use client';

/**
 * Scéna střelnice z očí (P68, kategorie `prvni-osoba`). Kostra z P68-I T1: jen podlaha s povrchem prostředí věty.
 * Koleje, terče a kameru z očí (`first`, `P68_VIEWS`), která jen sleduje `yawStep` ze stavu, dostane od kategorie.
 */

import { FieldGround } from '../../look/FieldGround';
import type { WorldProps } from '../../World';

/** Kam podlaha sahá (m). */
const LAND = { x0: -30, x1: 30, z0: -30, z1: 30 } as const;

export function RailfpsScene({ scene: look }: Omit<WorldProps, 'control' | 'backdrop'>) {
  return <FieldGround look={look} area={LAND} y={-0.03} />;
}
