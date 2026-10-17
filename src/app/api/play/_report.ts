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
import { verifyGame } from '@/play/verify';

export function reportFor(compiled: CompiledGame): QualityReport {
  if (compiled.arcade === undefined) return verifyGame(compiled);
  const verdict = verifyArcade(compiled.arcade);
  const report = arcadeReport(verdict, compiled.arcade, compiled);
  // Par jen u hry, která publikací projde: robot vyhrál a přehrání skončilo v jeho stavu (`replayEqual`), takže skóre
  // a tik jeho běhu jsou par bez čtvrtého přehrání (`parOf`) – to na delší trati ze vzorů (P46D) stálo čtvrtinu ověření.
  return report.publishEligible ? { ...report, par: { score: verdict.bot.score, ticks: verdict.bot.tick } } : report;
}
