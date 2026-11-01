'use client';

/**
 * Dotykový adaptér střelnice z očí (P68, kategorie `prvni-osoba`). Kostra z P68-I T1: nic nekreslí ani neposílá.
 * Kategorie ho naplní: tah natáčí přes `session.hold(axis)` jen hodnotami `RAILFPS_AXES` (`genre/p68-contract.ts`),
 * ťuk střílí přes `session.press(BUTTON.FIRE)`. Jiné API relace adaptér nevolá.
 */

import type { GenreTouchProps } from '../touch-registry';

export function RailfpsTouch(_props: GenreTouchProps) {
  return null;
}
