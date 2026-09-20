/**
 * **Dá slepení kusů týž svět jako jedno volání? Odpověď z archivu.**
 *
 * Plán P21 staví zrychlení na tom, že se kompilátorový požadavek dá rozřezat
 * na souběžné kusy nad společným rejstříkem plánovače. Ten předpoklad má
 * v plánu vlastní řádek v „Co nevíme": kdyby se slepený a referenční blueprint
 * rozešly, je odpověď „samostatný dokument světa" a fáze 2 se plánuje znovu.
 *
 * Tohle je to měření. **Nestojí ani jedno volání** — všech 72 kompilátorových
 * odpovědí z běhu 6. 9. 2026 leží v `create-raw.json` a compiler je
 * deterministický, takže se archiv jen přehraje: odpověď se rozřeže
 * `splitAnswerIntoChunks`, slepí `mergeEmissionChunks` a oba blueprinty se
 * porovnají bajtově.
 *
 * ⚠ **Co tohle měření NEodpovídá.** Řeže se hotová odpověď, tedy odpověď
 * napsaná modelem, který viděl celý svět naráz. Otázku „napíše Astra dobrý kus,
 * když nevidí zbytek?" tenhle běh nezodpoví a nikde se tak nesmí citovat —
 * na to je potřeba živý běh se třemi požadavky. Zodpovídá jen to, jestli
 * slepení samo něco ztrácí.
 *
 *     npx vitest run --config vitest.measure.mts evals/worldstream/chunked-compile.measure.ts
 *
 * Nechá po sobě `evals/worldstream/chunked-compile.json`, a ten se commituje:
 * v čistém klonu archiv chybí, takže je to jediné místo, kde ta čísla přežijí.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mergeEmissionChunks, splitAnswerIntoChunks } from '@/model/emission-merge';
import { compileBlueprint } from '@/model/worldstream-compiler';
import { readPlannerEmission } from '@/model/worldstream-intent';

/** Musí sedět s `replay-create.measure.ts`, jinak by se přehrával jiný běh. */
const SESSION_SEED = 4021;

const ARCHIVE = fileURLToPath(new URL('./create-raw.json', import.meta.url));
const REPORT = fileURLToPath(new URL('./chunked-compile.json', import.meta.url));

interface ArchiveEntry {
  readonly caseId: string;
  readonly call: number;
  readonly answer: unknown;
}

interface CaseRecord {
  readonly id: string;
  readonly chunks: number;
  readonly merged: boolean;
  readonly mergeRejection?: string;
  /** Zkompilovala se vůbec původní odpověď? Případy, které dnes neprojdou, se nepočítají. */
  readonly referenceCompiled: boolean;
  readonly identical?: boolean;
  readonly detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Plán té věty je první volání případu; kompilátorové odpovědi jsou ta další. */
function readArchive(): { plans: Map<string, unknown>; answers: ArchiveEntry[] } {
  const raw = JSON.parse(readFileSync(ARCHIVE, 'utf8')) as ArchiveEntry[];
  const plans = new Map<string, unknown>();
  const answers: ArchiveEntry[] = [];

  for (const entry of raw) {
    if (!isRecord(entry.answer)) continue;
    const fields = Object.keys(entry.answer);
    if (fields.includes('intent') && fields.includes('objects')) plans.set(entry.caseId, entry.answer);
    else if (fields.includes('geometry')) answers.push(entry);
  }
  return { plans, answers };
}

describe('slepení kusů nad archivem', () => {
  it('dá týž blueprint jako jedno volání, nebo to spočítá', () => {
    if (!existsSync(ARCHIVE)) {
      console.warn(`archiv ${ARCHIVE} tu není — měření se přeskakuje`);
      return;
    }

    const { plans, answers } = readArchive();
    const cases: CaseRecord[] = [];

    for (const entry of answers) {
      const id = `${entry.caseId}#${String(entry.call)}`;
      const answer = entry.answer as Record<string, unknown>;

      const planSource = plans.get(entry.caseId);
      const plan = planSource === undefined ? null : readPlannerEmission(planSource, { requireSceneSpec: false });
      if (plan === null || !plan.ok) {
        cases.push({ id, chunks: 0, merged: false, referenceCompiled: false, detail: 'planner emission unreadable' });
        continue;
      }

      const options = { sessionSeed: SESSION_SEED, upstream: { model: 'archived', system: 'system', user: 'user' } };
      const reference = compileBlueprint(answer, plan.value, options);

      const parts = splitAnswerIntoChunks(answer);
      const merged = mergeEmissionChunks(parts);
      if (!merged.ok) {
        cases.push({
          id,
          chunks: parts.length,
          merged: false,
          mergeRejection: merged.reason,
          referenceCompiled: reference.ok,
          detail: merged.detail,
        });
        continue;
      }

      const fromChunks = compileBlueprint(merged.answer, plan.value, options);
      cases.push({
        id,
        chunks: parts.length,
        merged: true,
        referenceCompiled: reference.ok,
        identical: JSON.stringify(fromChunks) === JSON.stringify(reference),
      });
    }

    const compiled = cases.filter((entry) => entry.referenceCompiled);
    const identical = compiled.filter((entry) => entry.identical === true);
    const drifted = compiled.filter((entry) => entry.merged && entry.identical !== true);
    const unmergeable = cases.filter((entry) => !entry.merged && entry.mergeRejection !== undefined);

    const report = {
      measuredAt: new Date().toISOString(),
      kind: 'deterministic replay of archived compiler answers — zero model calls, no HTTP',
      source: 'evals/worldstream/create-raw.json (2026-09-06 archive, seed 4021)',
      sessionSeed: SESSION_SEED,
      answersInArchive: cases.length,
      referenceCompiled: compiled.length,
      identicalBlueprint: identical.length,
      driftedBlueprint: drifted.length,
      mergeRejections: unmergeable.length,
      rejectionsByReason: unmergeable.reduce<Record<string, number>>((into, entry) => {
        const key = entry.mergeRejection ?? 'unknown';
        into[key] = (into[key] ?? 0) + 1;
        return into;
      }, {}),
      warnings: [
        'The answers were written by a model that saw the whole world at once. This measures only whether the merge loses anything; it says nothing about how well a model writes one chunk blind.',
        'Cases whose reference answer does not compile today are excluded from the denominator, never counted as a pass.',
      ],
      cases,
    };
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

    // Jmenovatel musí být neprázdný, jinak by report s nulou vypadal jako úspěch.
    expect(compiled.length, 'ani jedna archivovaná odpověď se nezkompilovala').toBeGreaterThan(0);
    // Tvrzení plánu: slepení nic neztrácí. Kdyby ztrácelo, je to platný výsledek
    // a čeká za ním přeplánování fáze 2 — proto se to tady nesmí protlačit.
    expect(drifted.map((entry) => entry.id)).toEqual([]);
    expect(unmergeable.map((entry) => `${entry.id}: ${entry.mergeRejection ?? ''}`)).toEqual([]);
  });
});
