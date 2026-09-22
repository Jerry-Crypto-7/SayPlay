/**
 * Šev verifikátoru pro obálku (P23-D T1): `verifyGame` z `src/play/verify` –
 * keypointy, svědek, dvojí replay a rozpočty. Publikace čte `publishEligible`.
 *
 * Podtržítko v názvu: Next.js soubor nebere jako route.
 */

import type { CompiledGame, QualityReport } from '@/play/contracts';
import { verifyGame } from '@/play/verify';

export function reportFor(compiled: CompiledGame): QualityReport {
  return verifyGame(compiled);
}
