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
 *
 * ## Co po sobě nechá
 *
 * `create-replay.json`, a ten se **commituje**. Je to jediná cesta, jak se
 * tvrzení o pohybu vět dá ověřit v repu, kde archiv chybí — bez něj zůstane
 * jen v commit zprávě. `create-report.json` se přitom nepřepisuje: měří model,
 * ne kód pod ním.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { frozenGrammar } from '@/model/client';
import { createMeshClient } from '@/shape/mesh-client';

import { readCorpus, type CreateCase } from './lock.mjs';
import {
  FAILURE_STAGES,
  archiveEmitter,
  buildCreateReport,
  compareReplay,
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

/**
 * **Vlastní soubor, a proto se commituje.** `create-report.json` měří model
 * a přehrání ho přepsat nesmí; tenhle měří kód pod ním.
 */
const REPLAY_FILE = fileURLToPath(new URL('./create-replay.json', import.meta.url));

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
        // **Nula je tu pravda, ne výchozí hodnota.** Přehrání odpovídá
        // z archivu, takže neutratí ani jedno volání — a právě proto se
        // jeho čísla nesmějí citovat jako výkon modelu.
        paidCalls: 0,
      });

      const comparison = compareReplay(before, after, new Date().toISOString());
      writeFileSync(REPLAY_FILE, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');

      const tally = (stages: Readonly<Record<FailureStage, number>>): string =>
        FAILURE_STAGES.filter((stage) => stages[stage] > 0)
          .map((stage: FailureStage) => `${stage} ${String(stages[stage])}`)
          .join(', ');

      process.stdout.write(
        [
          '',
          `authored  before ${String(comparison.before.geometryAuthored)}/${String(comparison.before.attempted)}  ->  replay ${String(comparison.after.geometryAuthored)}/${String(comparison.after.attempted)}`,
          `stages    before ${tally(comparison.before.failuresByStage)}`,
          `          replay ${tally(comparison.after.failuresByStage)}`,
          comparison.moved.length === 0
            ? 'no sentence changed verdict — the replay reproduces the archived run exactly'
            : `${String(comparison.moved.length)} sentences moved:\n  ${comparison.moved
                .map(
                  (move) =>
                    `${move.id}: ${move.from} -> ${move.to}${move.detail === null ? '' : ` (${move.detail.slice(0, 120)})`}`,
                )
                .join('\n  ')}`,
          '',
          // **Co dneska padá a proč, jmenovitě.** Je to celý smysl nástroje:
          // opravovat se má podle věty, kterou kód napsal, ne podle fáze.
          'what still fails:',
          ...after.cases
            .filter((entry) => entry.failure !== null)
            .map((entry) => `  ${entry.id} ${entry.failure!.stage}: ${entry.failure!.detail}`),
          '',
          `written to ${REPLAY_FILE}`,
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
