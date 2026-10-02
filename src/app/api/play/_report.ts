/**
 * Šev verifikátoru pro obálku (P23-D T1): `verifyGame` z `src/play/verify` –
 * keypointy, svědek, dvojí replay a rozpočty. Publikace čte `publishEligible`.
 * Arkádová hra (P25A) jde přes `verifyArcade` – robot, nečinný hráč, dvojí
 * přehrání – do téhož tvaru zprávy. Prošlá arkádová hra nese i `par`
 * (P36B T1): skóre a tik robotova vítězného běhu, měřítko hvězd.
 *
 * Podtržítko v názvu: Next.js soubor nebere jako route.
 */

import type { CompiledGame, QualityReport } from '@/play/contracts';
import { arcadeReport, verifyArcade } from '@/play/arcade/verify';
import { parOf } from '@/play/score/replay';
import { verifyGame } from '@/play/verify';

export function reportFor(compiled: CompiledGame): QualityReport {
  if (compiled.arcade === undefined) return verifyGame(compiled);
  const verdict = verifyArcade(compiled.arcade);
  const report = arcadeReport(verdict, compiled.arcade, compiled);
  // Par jen u hry, která publikací projde – jinak by přehrání stálo čas opravnému kolu režiséra zbytečně.
  const par = report.publishEligible ? parOf(compiled.arcade, verdict.bot.inputs) : null;
  return par === null ? report : { ...report, par };
}
