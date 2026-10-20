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
import type { ArcadeWorld } from '@/play/arcade/contract';
import { arcadeReport, type BotRun, verifyArcade } from '@/play/arcade/verify';
import { verifyGame } from '@/play/verify';
import { previewOf } from '@/play/version/preview';
import type { FeedPreview } from '@/play/version/version';

/** Vítězný běh robota hry, která prošla `reportFor` – náhled (`previewFor`) ho nepouští znovu. */
const passedRuns = new WeakMap<ArcadeWorld, BotRun>();

export function reportFor(compiled: CompiledGame): QualityReport {
  if (compiled.arcade === undefined) return verifyGame(compiled);
  const verdict = verifyArcade(compiled.arcade);
  const report = arcadeReport(verdict, compiled.arcade, compiled);
  if (!report.publishEligible) return report;
  passedRuns.set(compiled.arcade, verdict.bot);
  // Par jen u hry, která publikací projde: robot vyhrál a přehrání skončilo v jeho stavu (`replayEqual`), takže skóre
  // a tik jeho běhu jsou par bez čtvrtého přehrání (`parOf`) – to na delší trati ze vzorů (P46D) stálo čtvrtinu ověření.
  return { ...report, par: { score: verdict.bot.score, ticks: verdict.bot.tick } };
}

/**
 * Náhled robota do feedu (P54A T2) pro hru, kterou `reportFor` právě pustil – z téhož běhu. `null` = hra bez arkády
 * nebo bez prošlé kontroly. Publikace drží `reportFor` jako jediný šev zprávy (testy přes něj vnucují neprošlou hru).
 */
export function previewFor(compiled: CompiledGame): FeedPreview | null {
  const bot = compiled.arcade === undefined ? undefined : passedRuns.get(compiled.arcade);
  return compiled.arcade === undefined || bot === undefined ? null : previewOf(compiled.arcade, bot);
}
