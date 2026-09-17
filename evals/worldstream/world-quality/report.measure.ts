import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { CaseOutcome } from '../measure-create';
import { readQualityCases } from './corpus';
import { summarizeQualityRun, summarizeQualityStages, summarizeQualityRepairs, type QualityCall } from './summarize';

it('summarizes a saved P20 live run without model calls', () => {
  if (!process.env.P20_RUN_DIR) throw new Error('Set P20_RUN_DIR to the saved live run');
  const root = resolve(process.env.P20_RUN_DIR);
  const outcomes = JSON.parse(readFileSync(join(root, 'outcomes.json'), 'utf8')) as CaseOutcome[];
  const report = summarizeQualityRun(readQualityCases('all').map((entry) => entry.id), outcomes);
  writeFileSync(join(root, 'quality-summary.json'), JSON.stringify(report, null, 2));
  const groups = Object.fromEntries((['development', 'holdout'] as const).map((part) => {
    const ids = readQualityCases(part).map((entry) => entry.id);
    return [part, summarizeQualityRun(ids, outcomes.filter((outcome) => ids.includes(outcome.id)))];
  }));
  writeFileSync(join(root, 'group-summary.json'), JSON.stringify(groups, null, 2));
  const calls = JSON.parse(readFileSync(join(root, 'latency-raw.json'), 'utf8')) as QualityCall[];
  const repairs = summarizeQualityRepairs(outcomes, calls);
  writeFileSync(join(root, 'repair-summary.json'), JSON.stringify(repairs, null, 2));
  writeFileSync(join(root, 'stage-summary.json'), JSON.stringify(summarizeQualityStages(outcomes, calls), null, 2));
  writeFileSync(join(root, 'expected-cases.json'), JSON.stringify(readQualityCases('all'), null, 2));
  const ms = (value: number | null) => value === null ? 'nezměřeno' : `${Math.round(value)} ms`;
  const rows = readQualityCases('all').map(({ id }) => {
    const outcome = outcomes.find((entry) => entry.id === id);
    const status = !outcome ? 'pending' : outcome.certified && outcome.worldValid ? 'certifikovaný proxy svět' : `odmítnuto: ${outcome.failure?.stage ?? 'unknown'}`;
    return `| ${id} | ${status} | ${ms(outcome?.latencyMs ?? null)} |`;
  });
  writeFileSync(join(root, 'final-report.md'), [
    '# P20 — souhrn živé série', '',
    `Stav dat: **${report.status}**, dokončeno **${report.completed}/${report.expected}**. Certifikované proxy světy: **${report.certifiedProxyWorlds}/${report.expected}**.`, '',
    `Původní sada: ${groups.development.certifiedProxyWorlds}/10, holdout: ${groups.holdout.certifiedProxyWorlds}/20.`, '',
    `Čas všech dokončených případů včetně odmítnutých: medián **${ms(report.latencyAllCompleted.medianMs)}**, p95 **${ms(report.latencyAllCompleted.p95Ms)}**.`, '',
    `Certifikace bez opravy: **${repairs.counts['certified-without-repair']}**, po opravě: **${repairs.counts['certified-after-repair']}**. Odmítnuté po opravě: **${repairs.counts['rejected-after-repair']}**, bez opravy: **${repairs.counts['rejected-without-repair']}**. Chybějící záznamy volání: **${repairs.counts.unobserved}**. Podrobnosti a čas oprav: [repair-summary.json](repair-summary.json). Důvody vstupující do opravy nejsou totéž jako konečná chyba; úspěch po opravě sám neprokazuje její kauzální přínos.`, '',
    '| Případ | Výsledek | Node generování/překlad |', '|---|---|---:|', ...rows, '',
    'Časy modelových volání včetně transportu a zbytek zpracování jsou ve [stage-summary.json](stage-summary.json). Rozdělení původní sady a holdoutu je v [group-summary.json](group-summary.json). Prostředí a výchozí revize jsou v [environment.json](environment.json).', '',
    'Výsledky galerie se ověřují samostatně: [stav dokončení](finalization.json), [galerie](quality/gallery.html), [slepá galerie](quality/blind.html), [browserová pozorování](quality/browser-observations.json), [1080p profil](quality/frame-profile.json). Tyto soubory mohou vzniknout až po tomto souhrnu; jejich existenci ani PASS tento text nepředjímá.', '',
    '**Produktové brány se tím neprohlašují za splněné.** Proxy certifikace není browserový live stav ani lidská rozpoznatelnost. Promptové browserové časy, cold/warm rozdělení, referenční notebook a lidské/A4 hodnocení vyžadují samostatný důkaz.', '',
  ].join('\n'));
  expect(report.status, 'baseline is still incomplete; pending IDs retained in summary').toBe('complete');
});
