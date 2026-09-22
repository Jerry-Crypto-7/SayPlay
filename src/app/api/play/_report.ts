/**
 * Šev verifikátoru pro obálku (P23-D T1): `verifyGame` z `src/play/verify` –
 * keypointy, svědek, dvojí replay a rozpočty. Publikace čte `publishEligible`.
 * Arkádová hra (P25A) jde přes `verifyArcade` – robot, nečinný hráč, dvojí
 * přehrání – do téhož tvaru zprávy.
 *
 * Podtržítko v názvu: Next.js soubor nebere jako route.
 */

import type { CompiledGame, QualityReport } from '@/play/contracts';
import { arcadeReport, verifyArcade } from '@/play/arcade/verify';
import { verifyGame } from '@/play/verify';

export function reportFor(compiled: CompiledGame): QualityReport {
  if (compiled.arcade !== undefined) return arcadeReport(verifyArcade(compiled.arcade), compiled.arcade, compiled);
  return verifyGame(compiled);
}
