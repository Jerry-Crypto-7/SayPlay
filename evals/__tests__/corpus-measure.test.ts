/**
 * T8 — měřidlo celé 200větové sady.
 *
 * Vstupní adresář je celý zmrazený, takže test záměrně očekává výstup mimo
 * `evals/corpus-v3/`. Přidat report dovnitř by samo shodilo manifest.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EXAMPLE_MARKER } from '../../src/model/prompt';
import {
  CORPUS_REPORT_PATH,
  CORPUS_TOTAL,
  buildCorpusReport,
  inspectCorpusIntegrity,
  integrityFailure,
  loadCorpusCases,
  measurementFailure,
  scoreCorpusAttempt,
  splitCorpusCases,
  type CorpusCase,
  type CorpusAttempt,
  type CorpusCaseMeasurement,
} from '../measure-corpus';

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    // Smazání se děje jen v adresáři vytvořeném `mkdtempSync(tmpdir())`.
    rmSync(dir, { recursive: true, force: true });
  }
});

function measured(
  id: string,
  verdict: CorpusCaseMeasurement['verdict'],
  source: CorpusCaseMeasurement['source'],
  emissionValid: boolean,
  latencyMs: number,
): CorpusCaseMeasurement {
  return {
    id,
    bucket: 'test',
    scoreAs: 'FULFILLABLE',
    source,
    verdict,
    emissionValid,
    latencyMs,
    finishReason: 'stop',
    detail: '',
    observations: [],
  };
}

const EXAMPLE_WORLD: Record<string, unknown> = (() => {
  const system = loadCorpusCases()[0]!.system;
  const at = system.indexOf(EXAMPLE_MARKER);
  return JSON.parse(system.slice(at + EXAMPLE_MARKER.length).trim()) as Record<string, unknown>;
})();

function caseWith(
  scoreAs: CorpusCase['scoreAs'],
  observations: CorpusCase['contract']['observations'],
): CorpusCase {
  return {
    ...loadCorpusCases()[0]!,
    scoreAs,
    contract: { mustBuild: true, observations: [...observations] },
  };
}

function attempt(raw: unknown, overrides: Partial<CorpusAttempt> = {}): CorpusAttempt {
  return {
    id: 'P001',
    source: 'model',
    latencyMs: 10,
    finishReason: 'stop',
    raw: typeof raw === 'string' ? raw : JSON.stringify(raw),
    error: '',
    ...overrides,
  };
}

describe('integrita korpusu T8', () => {
  it('načte právě 200 zamčených vět a výstup drží mimo jejich adresář', () => {
    expect(CORPUS_TOTAL).toBe(200);
    expect(loadCorpusCases()).toHaveLength(200);
    expect(CORPUS_REPORT_PATH).toBe(join('evals', 'corpus-report.json'));
  });

  it('produkční routing rozdělí všech 200 vět beze ztráty a duplicity', () => {
    const cases = loadCorpusCases();
    const routed = splitCorpusCases(cases);
    expect(routed.handled).toHaveLength(26);
    expect(routed.forModel).toHaveLength(174);
    expect(new Set([...routed.handled, ...routed.forModel].map((entry) => entry.id)).size).toBe(200);
  });

  it('aktuální manifest sedí a report nese jeho SHA-256', () => {
    const integrity = inspectCorpusIntegrity();
    expect(integrityFailure(integrity)).toBeNull();
    expect(integrity.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(integrity.files).toEqual(['lock.d.mts', 'lock.mjs', 'prompts.json']);
  });

  it('přidaný soubor ve scratch kopii je porušení integrity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-measure-'));
    scratch.push(dir);
    cpSync(join('evals', 'corpus-v3'), dir, { recursive: true });
    writeFileSync(join(dir, 'report.json'), '{}\n', 'utf8');

    expect(integrityFailure(inspectCorpusIntegrity(dir))).toContain('report.json');
  });
});

describe('report T8', () => {
  it('oddělí čtyři verdikty, počítá platnost a medián jen z modelu', () => {
    const cases = [
      measured('P001', 'FULFILLED', 'recognizer', true, 0),
      measured('P002', 'ROBUST', 'model', true, 10),
      measured('P003', 'NO_FIT', 'model', true, 30),
      measured('P004', 'FAULT', 'model', false, 50),
    ];
    const report = buildCorpusReport({
      measuredAt: '2026-08-25T00:00:00.000Z',
      adapter: 'nvidia/ampere',
      model: 'test-model',
      manifestSha256: 'a'.repeat(64),
      cases,
    });

    expect(report).toMatchObject({
      attempts: 4,
      fulfilled: 1,
      robust: 1,
      noFit: 1,
      fault: 1,
      schemaValid: 0.75,
      medianLatencyMs: 30,
      shapesHandled: 1,
      modelAttempts: 3,
    });
    expect(report.confidenceInterval).toMatchObject({ successes: 3, trials: 4, point: 0.75 });
    expect(report.corpusManifestSha256).toBe('a'.repeat(64));
  });

  it('odmítnutí za schema branou nesníží schemaValid', () => {
    const rejectedAfterSchema = {
      ...measured('P001', 'FAULT', 'model', false, 10),
      detail: 'references: DANGLING_REFERENCE',
    };
    const malformed = { ...measured('P002', 'FAULT', 'model', false, 20), detail: 'schema: SCHEMA_VIOLATION' };
    const report = buildCorpusReport({
      measuredAt: 'x',
      adapter: 'nvidia/ampere',
      model: 'test-model',
      manifestSha256: 'c'.repeat(64),
      cases: [rejectedAfterSchema, malformed],
    });

    expect(report.schemaValid).toBe(0.5);
    expect(report.confidenceInterval).toMatchObject({ successes: 1, trials: 2, point: 0.5 });
    expect(report.fault).toBe(2);
  });

  it('špatný výsledek zůstane platný report — integrita je jediná datová brána', () => {
    const report = buildCorpusReport({
      measuredAt: 'x',
      adapter: 'nvidia/ampere',
      model: 'test-model',
      manifestSha256: 'b'.repeat(64),
      cases: [measured('P001', 'FAULT', 'model', false, 1)],
    });

    expect(report.schemaValid).toBe(0);
    expect(report.fault).toBe(1);
    expect(integrityFailure({ ok: true, corpusVersion: 'v3', manifestSha256: 'b'.repeat(64), files: [], problems: [] })).toBeNull();
  });

  it('nenulový exit žádá jen porušená integrita nebo neúplných 200 pokusů', () => {
    const ok = { ok: true, corpusVersion: 'v3', manifestSha256: 'b'.repeat(64), files: [], problems: [] } as const;
    expect(measurementFailure(ok, 200)).toBeNull();
    expect(measurementFailure(ok, 199)).toContain('199');
    expect(measurementFailure({ ...ok, ok: false, problems: ['prompts.json: drift'] }, 200)).toContain('drift');
  });

  it('uložený report jde přepočítat z perSentence bez dalšího GPU běhu', () => {
    const stored = JSON.parse(readFileSync(CORPUS_REPORT_PATH, 'utf8')) as ReturnType<typeof buildCorpusReport>;
    const rebuilt = buildCorpusReport({
      measuredAt: stored.measuredAt,
      adapter: stored.adapter,
      model: stored.model,
      manifestSha256: stored.corpusManifestSha256,
      cases: stored.perSentence,
    });

    expect(rebuilt).toEqual(stored);
    expect(stored).toMatchObject({ attempts: 200, schemaValid: 0.99, fulfilled: 1, robust: 146, noFit: 0, fault: 53 });
    expect(stored.corpusManifestSha256).toBe(inspectCorpusIntegrity().manifestSha256);
  });
});

describe('konzervativní verdikt T8', () => {
  it('FULFILLED vyžaduje certifikovaný svět a všechny strojově ověřené observace', () => {
    const entry = caseWith('FULFILLABLE', [
      { rid: 'P001.o1', kind: 'sceneNotEmpty', says: 'scéna stojí' },
      { rid: 'P001.o2', kind: 'noRuntimeFault', says: 'replay nespadne' },
      { rid: 'P001.o3', kind: 'notWinnableAtSetup', says: 'na začátku není vyhráno' },
      { rid: 'P001.o4', kind: 'reachesWin', value: 600, says: 'svědek vyhraje' },
    ]);
    const result = scoreCorpusAttempt(entry, attempt(EXAMPLE_WORLD));

    expect(result.verdict).toBe('FULFILLED');
    expect(result.emissionValid).toBe(true);
    expect(result.observations.every((observation) => observation.met)).toBe(true);
  });

  it('přirozeně pojmenovanou bránu nehádá a tím nenafoukne headline', () => {
    const entry = caseWith('FULFILLABLE', [
      {
        rid: 'P001.o1',
        kind: 'gatedProgress',
        value: { blocker: 'východ', key: 'všechny tři klíče drženy' },
        says: 'brána drží do sebrání klíčů',
      },
    ]);
    const result = scoreCorpusAttempt(entry, attempt(EXAMPLE_WORLD));

    expect(result.verdict).toBe('ROBUST');
    expect(result.observations[0]).toMatchObject({ met: false });
    expect(result.observations[0]!.detail).toContain('stabilní id');
  });

  it('ROBUST_ONLY nemůže dostat FULFILLED ani když všechny observace sedí', () => {
    const entry = caseWith('ROBUST_ONLY', [{ rid: 'P001.o1', kind: 'sceneNotEmpty', says: 'scéna stojí' }]);
    expect(scoreCorpusAttempt(entry, attempt(EXAMPLE_WORLD)).verdict).toBe('ROBUST');
  });

  it('platné odmítnutí zůstane NO_FIT a scéna i odmítnutí se změří zvlášť', () => {
    const entry = caseWith('NO_FIT_EXPECTED', [
      { rid: 'P001.o1', kind: 'sceneNotEmpty', says: 'scéna stojí' },
      { rid: 'P001.o2', kind: 'honestRefusal', value: 'mechanika mimo slovník', says: 'systém odmítne sim' },
    ]);
    const declined = { ...EXAMPLE_WORLD, simOutcome: 'NO_FIT', sim: null };
    const result = scoreCorpusAttempt(entry, attempt(declined));

    expect(result).toMatchObject({ verdict: 'NO_FIT', emissionValid: true });
    expect(result.observations.every((observation) => observation.met)).toBe(true);
  });

  it('pád i odmítnutí certifikační branou jsou FAULT, ne nesplněná observace', () => {
    const entry = caseWith('FULFILLABLE', [{ rid: 'P001.o1', kind: 'sceneNotEmpty', says: 'scéna stojí' }]);
    expect(scoreCorpusAttempt(entry, attempt('', { error: 'GPU device lost' }))).toMatchObject({
      verdict: 'FAULT',
      emissionValid: false,
    });
    expect(scoreCorpusAttempt(entry, attempt('{broken:true}'))).toMatchObject({
      verdict: 'FAULT',
      emissionValid: false,
    });
  });
});
