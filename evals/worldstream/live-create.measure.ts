/**
 * **Živý běh create cesty (P13 T14). Tenhle soubor utrácí skutečné peníze.**
 *
 * Třicet zmrazených vět projde celým řetězem proti cloudovému modelu a z toho
 * vznikne `create-report.json` — číslo, podle kterého brána K2 rozhoduje,
 * jestli vlna 3 vůbec začne.
 *
 * ## Proč to není `*.test.ts`
 *
 * `vitest.config.mts` sbírá `evals/**` s příponou `.test.ts`, takže cokoli
 * takového běží při každém `npm test`. Přesně tímhle se 31. 8. 2026 přepisoval
 * `evals/hostile-report.json` — jednotkovou sadou, ne e2e. Placený běh takhle
 * zapojený by se spustil při každém testu, a to je chyba, kterou by nikdo
 * nezpozoroval dřív než na účtu. Přípona `.measure.ts` do výchozího `include`
 * nepatří a spustí ji **jedině** vlastní konfigurace `vitest.measure.mts`,
 * tedy `npm run measure:worldstream-create`. Hlídá to
 * `__tests__/measure-create.test.ts`.
 *
 * ## Co je tady a co v `measure-create.ts`
 *
 * Tady je **zapojení** — prostředí, skutečný `fetch`, zápis dvou souborů.
 * Všechno, co rozhoduje, včetně placeného volání a stropu, bydlí
 * v `measure-create.ts`, protože jedině tam se to dá projet testem proti
 * atrapě. Kdyby placená cesta zůstala v tomhle souboru, ověřil by ji poprvé
 * až běh, který za ni platí.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { frozenGrammar } from '@/model/client';
import { createMeshClient } from '@/shape/mesh-client';

import { readCorpus, verifyAgainstManifest, type CreateCase } from './lock.mjs';
import {
  buildCreateReport,
  driveCreateCase,
  liveEmitter,
  type CaseOutcome,
} from './measure-create';

/** Semínko běhu. Pevné, aby dva běhy nad týmž modelem šly porovnat. */
const SESSION_SEED = 4021;

const REPORT_FILE = fileURLToPath(new URL('./create-report.json', import.meta.url));
const ARCHIVE_FILE = fileURLToPath(new URL('./create-raw.json', import.meta.url));

describe('the live create path over the frozen set', () => {
  it(
    'builds a report the gate can rule on',
    async () => {
      // Zámek napřed. Měřit nad korpusem, který se mezitím pohnul, je dražší
      // než neměřit vůbec: číslo by vypadalo úplně stejně.
      const drift = verifyAgainstManifest();
      expect(drift, `the frozen corpus moved: ${drift.join('; ')}`).toEqual([]);

      const corpus = readCorpus();
      expect(corpus.parseProblems).toEqual([]);

      const grammar = frozenGrammar();
      if (!grammar.ok) throw new Error(`${grammar.reason}: ${grammar.detail}`);

      const upstream = liveEmitter(process.env);
      // Prohlížeč tahle cesta nepotřebuje: cloudový model nepočítá na GPU
      // a meshovač umí spočítat tvar i na hlavním vlákně.
      const mesh = createMeshClient({ allowMainThread: true });

      const cases: CaseOutcome[] = [];
      let report: ReturnType<typeof buildCreateReport> | null = null;
      try {
        for (const entry of corpus.create as CreateCase[]) {
          upstream.caseId = entry.id;
          const done = await driveCreateCase(entry, {
            emit: (request) => upstream.emit(request),
            mesh: mesh.mesh,
            grammar: grammar.value,
            sessionSeed: SESSION_SEED,
          });
          cases.push(done);
          process.stdout.write(
            `${entry.id} ${done.geometryAuthored ? 'authored' : (done.failure?.stage ?? 'lost')} ${String(Math.round(done.latencyMs))} ms\n`,
          );
        }
      } finally {
        mesh.dispose();
        report = buildCreateReport(cases, {
          sessionSeed: SESSION_SEED,
          measuredAt: new Date().toISOString(),
        });
        // **Obojí se zapíše i po pádu uprostřed.** Meshing ani profil nejsou
        // v `driveCreateCase` chráněné, takže výjimka u dvacáté deváté věty by
        // jinak znamenala 29 zaplacených vět a žádný report.
        //
        // **A obojí projde scrubbingem emitoru**, ne jen archiv: hlášky `fetch`e
        // nesou celou adresu koncového bodu a doputují až do `failure.detail`.
        writeFileSync(
          ARCHIVE_FILE,
          `${JSON.stringify(upstream.scrub(upstream.archive), null, 2)}\n`,
          'utf8',
        );
        writeFileSync(REPORT_FILE, `${JSON.stringify(upstream.scrub(report), null, 2)}\n`, 'utf8');
      }

      process.stdout.write(
        `\n${String(report.totals.geometryAuthored)}/${String(report.totals.attempted)} authored, p95 ${String(Math.round(report.latencyP95Ms))} ms, closest pair ${report.closestPair?.distance.toFixed(4) ?? 'n/a'}, ${String(upstream.paidCalls)} paid calls\n`,
      );

      // Brána až nakonec, aby report na disku byl i tehdy, když padne.
      expect(report.totals.attempted).toBe(corpus.create.length);
      expect(report.gateFailures).toEqual([]);
    },
    // Třicet vět krát až tři kola sebeopravy, každé kolo řádově desítky sekund.
    45 * 60_000,
  );
});
