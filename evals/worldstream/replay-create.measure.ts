/**
 * **Přehrání běhu `T14` z archivu. Nestojí ani jedno volání.**
 *
 * Běh 6. 9. 2026 trval 70 minut a 104 placených volání a skončil červeně:
 * `geometryAuthored` 9 z 30. Většina těch selhání ale nebyla v odpovědích
 * modelu — byla v kódu, který je zpracovává (`T14r-shapebounds`,
 * `T14r-orphanslot`, `T14r-identifier`). Otázka *„srovnala by tahle oprava ty
 * věty?"* má proto odpověď na disku: v `create-raw.json` leží všech 104
 * odpovědí a compiler i meshovač jsou deterministické, takže přehrání dá při
 * nezměněném kódu **tytéž** blueprinty.
 *
 * ⚠ **Tohle není měření modelu a nikde tak nesmí vystupovat.** Model
 * v přehrání nedostane ani jednu novou šanci: věta, kterou minule napsal
 * špatně, bude špatně i teď. Čísla odsud patří k opravám, ne do reportu
 * o schopnostech modelu, a bránu `K2` zavře výhradně nový živý běh.
 *
 * ## Proč `.measure.ts`, když se tu neplatí
 *
 * Sáhne na `create-raw.json`, který je v `.gitignore` — v čistém klonu tedy
 * neexistuje. Pod příponou `.test.ts` by ho `npm test` hledal a padal na
 * stroji, kde nikdo nic neměřil. `.measure.ts` znamená „pustí se, jen když si
 * o to někdo řekne", a to je přesně ono.
 *
 *     npm run measure:worldstream-replay
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { frozenGrammar } from '@/model/client';
import { createMeshClient } from '@/shape/mesh-client';

import { readCorpus, type CreateCase } from './lock.mjs';
import {
  FAILURE_STAGES,
  archiveEmitter,
  buildCreateReport,
  driveCreateCase,
  type ArchiveEntry,
  type CaseOutcome,
  type CreateReport,
  type FailureStage,
} from './measure-create';

/** Musí sedět s `live-create.measure.ts`, jinak by se přehrával jiný běh. */
const SESSION_SEED = 4021;

const ARCHIVE_FILE = fileURLToPath(new URL('./create-raw.json', import.meta.url));
const REPORT_FILE = fileURLToPath(new URL('./create-report.json', import.meta.url));

describe('the archived run, replayed against the current code', () => {
  it(
    'says which sentences the code under the model would now build',
    async () => {
      expect(
        existsSync(ARCHIVE_FILE),
        `${ARCHIVE_FILE} is missing — it is gitignored, so run npm run measure:worldstream-create first`,
      ).toBe(true);

      const archive = JSON.parse(readFileSync(ARCHIVE_FILE, 'utf8')) as ArchiveEntry[];
      const before = JSON.parse(readFileSync(REPORT_FILE, 'utf8')) as CreateReport;

      const corpus = readCorpus();
      expect(corpus.parseProblems).toEqual([]);

      const grammar = frozenGrammar();
      if (!grammar.ok) throw new Error(`${grammar.reason}: ${grammar.detail}`);

      const mesh = createMeshClient({ allowMainThread: true });
      const cases: CaseOutcome[] = [];
      try {
        for (const entry of corpus.create as CreateCase[]) {
          cases.push(
            await driveCreateCase(entry, {
              emit: archiveEmitter(archive, entry.id),
              mesh: mesh.mesh,
              grammar: grammar.value,
              sessionSeed: SESSION_SEED,
            }),
          );
        }
      } finally {
        mesh.dispose();
      }

      const after = buildCreateReport(cases, {
        sessionSeed: SESSION_SEED,
        measuredAt: new Date().toISOString(),
        planned: corpus.create.length,
      });

      // **Řádek dostane jen ta věta, která se pohnula.** Třicet nezměněných
      // řádků je šum, ve kterém se ten jeden pohyb ztratí.
      const was = new Map(before.cases.map((entry) => [entry.id, entry]));
      const moved: string[] = [];
      for (const now of after.cases) {
        const then = was.get(now.id);
        if (then === undefined) continue;
        const from = then.geometryAuthored ? 'authored' : (then.failure?.stage ?? 'lost');
        const to = now.geometryAuthored ? 'authored' : (now.failure?.stage ?? 'lost');
        if (from === to) continue;
        moved.push(`${now.id}: ${from} -> ${to}${now.failure === null ? '' : ` (${now.failure.detail.slice(0, 120)})`}`);
      }

      const tally = (report: CreateReport): string =>
        FAILURE_STAGES.filter((stage) => report.failuresByStage[stage] > 0)
          .map((stage: FailureStage) => `${stage} ${String(report.failuresByStage[stage])}`)
          .join(', ');

      process.stdout.write(
        [
          '',
          `authored  before ${String(before.totals.geometryAuthored)}/${String(before.totals.attempted)}  ->  replay ${String(after.totals.geometryAuthored)}/${String(after.totals.attempted)}`,
          `stages    before ${tally(before)}`,
          `          replay ${tally(after)}`,
          moved.length === 0
            ? 'no sentence changed verdict — the replay reproduces the archived run exactly'
            : `${String(moved.length)} sentences moved:\n  ${moved.join('\n  ')}`,
          '',
          // **Co dneska padá a proč, jmenovitě.** Je to celý smysl nástroje:
          // opravovat se má podle věty, kterou kód napsal, ne podle fáze.
          'what still fails:',
          ...after.cases
            .filter((entry) => entry.failure !== null)
            .map((entry) => `  ${entry.id} ${entry.failure!.stage}: ${entry.failure!.detail}`),
          '',
        ].join('\n'),
      );

      // Jediné tvrzení téhle sady: archiv se přehrál celý. Verdikt o modelu
      // tady nepadá a padnout nesmí.
      expect(after.totals.attempted).toBe(corpus.create.length);
    },
    20 * 60_000,
  );
});
