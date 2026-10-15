/**
 * 2× (P46C): body ze sebrání krát 2. Násobí vedle komba, ne v něm – počítadlo komba
 * si zapíše jen svůj násobič, jinak by se 2× s každým dalším sebráním násobilo znovu.
 */

import { powerupOf } from '../contract';

/** Násobič bodů od power-upu v počítadle `keeper` (bez počítadla 1). */
export const scoreFactor = (state: Int32Array, keeper: number | undefined): number => (keeper !== undefined && powerupOf(state, keeper) === 'double' ? 2 : 1);
