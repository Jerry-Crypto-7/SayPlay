/**
 * **Anatomie odpovědi plánovače — pin na jmenovatel a na součet.**
 *
 * Artefakt `planner-anatomy.json` říká, co v odpovědi plánovače zabírá
 * místo. Dvě věci na něm vypadají jako výsledek, i když jsou špatně: plán,
 * který z archivu vypadl (průměr nad sedmnácti čísly je pořád číslo), a
 * podíly, které nesedí na celek (když měřidlo některé pole spočítá dvakrát
 * nebo vůbec). Sada proto soudí artefakt, ne kód: jmenovatel je 18 a
 * `intent + objects + sceneSpec + envelope = whole` v každém plánu.
 *
 * Znovu ho naměří (nula volání modelu):
 *
 *     npx vitest run --config vitest.measure.mts evals/worldstream/planner-anatomy.measure.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPORT_FILE = fileURLToPath(new URL('../planner-anatomy.json', import.meta.url));

/** Archiv T18 má 18 plánovačských odpovědí — stejný jmenovatel jako `massing-preview.json`. */
const ARCHIVE_PLANS = 18;

interface SceneSpecBytes {
  readonly provenance: number;
  readonly requirements: number;
  readonly instances: number;
  readonly instanceAttributes: number;
  readonly instanceOrientation: number;
  readonly instanceRequirementIds: number;
  readonly relations: number;
  readonly clarifications: number;
}

interface AnswerBytes {
  readonly whole: number;
  readonly intent: number;
  readonly objects: number;
  readonly sceneSpec: number;
  readonly envelope: number;
  readonly sceneSpecFields: SceneSpecBytes;
}

interface AnatomyReport {
  readonly measuredAt: string;
  readonly source: string;
  readonly plans: number;
  readonly average: AnswerBytes;
  readonly shareOfWhole: Record<string, number>;
  readonly cases: readonly (AnswerBytes & { readonly id: string })[];
}

const report = JSON.parse(readFileSync(REPORT_FILE, 'utf8')) as AnatomyReport;

describe('planner-anatomy.json – co zabírá místo v odpovědi plánovače', () => {
  it('nechybí ani jeden z 18 plánů archivu a jmenovatel v hlavičce sedí', () => {
    expect(report.plans).toBe(ARCHIVE_PLANS);
    expect(report.cases).toHaveLength(ARCHIVE_PLANS);
    expect(new Set(report.cases.map((entry) => entry.id)).size).toBe(ARCHIVE_PLANS);
    expect(report.source).toContain('t18-hybrid-v2-20260917-1803');
  });

  it('v každém plánu dávají intent + objects + sceneSpec + obal přesně celek', () => {
    for (const entry of report.cases) {
      expect(entry.intent + entry.objects + entry.sceneSpec + entry.envelope, entry.id).toBe(entry.whole);
      expect(entry.envelope, entry.id).toBeGreaterThan(0);
    }
  });

  it('pole uvnitř sceneSpec nepřesahují sceneSpec a instance nesou své podpole', () => {
    for (const entry of report.cases) {
      const f = entry.sceneSpecFields;
      expect(f.requirements + f.instances + f.relations + f.clarifications, entry.id).toBeLessThanOrEqual(entry.sceneSpec);
      expect(f.instanceAttributes + f.instanceOrientation + f.instanceRequirementIds, entry.id).toBeLessThanOrEqual(f.instances);
      expect(f.provenance, entry.id).toBeLessThanOrEqual(entry.sceneSpec);
    }
  });

  it('průměr je průměr případů a podíly na celku dávají dohromady jedna', () => {
    const mean = (pick: (entry: AnswerBytes) => number) =>
      Math.round(report.cases.reduce((sum, entry) => sum + pick(entry), 0) / report.cases.length);
    expect(report.average.whole).toBe(mean((e) => e.whole));
    expect(report.average.sceneSpec).toBe(mean((e) => e.sceneSpec));
    expect(report.average.sceneSpecFields.provenance).toBe(mean((e) => e.sceneSpecFields.provenance));

    const { intent, objects, sceneSpec, envelope } = report.shareOfWhole;
    expect(intent + objects + sceneSpec + envelope).toBeCloseTo(1, 2);
  });
});
