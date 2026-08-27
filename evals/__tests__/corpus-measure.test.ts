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
  driveCorpusCase,
  inspectCorpusIntegrity,
  integrityFailure,
  loadCorpusCases,
  measurementFailure,
  recognizerAttempt,
  scoreCorpusAttempt,
  splitCorpusCases,
  summariseRounds,
  type CorpusCase,
  type CorpusAttempt,
  type CorpusCaseMeasurement,
} from '../measure-corpus';

import type { ChatEngine } from '../../src/model/local/engine';

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
  rounds = 1,
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
    rounds,
    firstRoundPassed: emissionValid && rounds <= 1,
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
    rounds: [{ attempt: 1, ms: 10, stage: null, reason: null }],
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
    // ⚠ **Čísla se 26. 8. 2026 pohnula a je to nález, ne přepis pinu.**
    // Stará hodnota `schemaValid 0.99, fulfilled 1, robust 146, fault 53`
    // pochází z běhu 25. 8. 17:36. Po něm přišly tři změny promptu z vlny 1
    // (`f1c9d03`, `f122ea1`, `8f9767e`, všechny 26. 8.), které modelu zakázaly
    // opisovat jména z ukázky. Nikdo je nezměřil. Tenhle běh je jejich první
    // měření a **kolo 1 spadlo ze 121/174 na 48/174**. Kolo 1 je přitom
    // požadavek byte po bytu shodný s tím starým — pine to test o pár řádků
    // níž — takže to nemůže být opravnou smyčkou vlny 2.
    expect(stored).toMatchObject({ attempts: 200, schemaValid: 0.79, fulfilled: 0, robust: 75, noFit: 0, fault: 125 });
    // Přínos smyčky: 1 věta z 200. Brána vlny žádala +15 procentních bodů.
    expect(stored.rounds).toMatchObject({ passedFirstRound: 74, passedAfterRepair: 75, repaired: 1, gainPoints: 0.5 });
    expect(stored.rounds.histogram).toEqual({ '1': 74, '2': 79, '3': 47 });
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

/**
 * P12 V2 T4 — měřidlo prochází opravnou smyčkou, ne jen certifikací.
 *
 * Testuje se `driveCorpusCase()` s podstrčeným strojem, protože to je jediné
 * místo, kde se dá kolo vyrobit bez GPU. Tím se pokryje všechno kromě lepidla
 * na `page.evaluate` v `e2e/corpus-measure.spec.ts`, které jen přeposílá řetězce.
 */
describe('opravná smyčka v měřidle T4', () => {
  /** Svět, který projde branou a **není** doslovnou ukázkou ze systémové zprávy. */
  const OWN_WORLD = { ...EXAMPLE_WORLD, simRevision: 1 };

  function engineReplying(replies: readonly string[]): ChatEngine {
    let at = 0;
    return {
      modelId: 'fake-model',
      async complete() {
        const raw = replies[Math.min(at, replies.length - 1)]!;
        at += 1;
        if (raw === '__throw__') throw new Error('GPU device lost');
        return { raw, finishReason: 'stop' };
      },
      async unload() {},
    };
  }

  const entry = (): CorpusCase => loadCorpusCases()[0]!;

  it('odmítnutá emise dostane další kolo a měří se ta, která nakonec prošla', async () => {
    const attempt = await driveCorpusCase(entry(), engineReplying(['{}', JSON.stringify(OWN_WORLD)]));

    expect(attempt.rounds).toHaveLength(2);
    expect(attempt.rounds[0]).toMatchObject({ attempt: 1, stage: 'schema' });
    expect(attempt.rounds[1]).toMatchObject({ attempt: 2, stage: null, reason: null });
    expect(JSON.parse(attempt.raw)).toMatchObject({ simRevision: 1 });
    expect(attempt.error).toBe('');

    const scored = scoreCorpusAttempt(entry(), attempt);
    expect(scored).toMatchObject({ emissionValid: true, rounds: 2, firstRoundPassed: false });
  });

  it('emise, která projde napoprvé, se neopakuje a hlásí základnu bez smyčky', async () => {
    const attempt = await driveCorpusCase(entry(), engineReplying([JSON.stringify(OWN_WORLD)]));

    expect(attempt.rounds).toHaveLength(1);
    const scored = scoreCorpusAttempt(entry(), attempt);
    expect(scored).toMatchObject({ emissionValid: true, rounds: 1, firstRoundPassed: true });
  });

  it('nepohnuté odmítnutí smyčku zastaví a věta zůstane FAULT', async () => {
    const attempt = await driveCorpusCase(entry(), engineReplying(['{}']));

    expect(attempt.rounds).toHaveLength(2);
    expect(attempt.rounds.every((round) => round.stage === 'schema')).toBe(true);
    expect(scoreCorpusAttempt(entry(), attempt)).toMatchObject({
      verdict: 'FAULT',
      rounds: 2,
      firstRoundPassed: false,
    });
  });

  it('pád stroje je chyba prostředí, ne verdikt — a odehraná kola zůstanou', async () => {
    const attempt = await driveCorpusCase(entry(), engineReplying(['{}', '__throw__']));

    expect(attempt.error).toContain('GPU device lost');
    expect(attempt.rounds).toHaveLength(1);
    expect(scoreCorpusAttempt(entry(), attempt)).toMatchObject({ verdict: 'FAULT', firstRoundPassed: false });
  });

  it('doslovná kopie ukázky je FAULT, i když je to sám o sobě platný svět', async () => {
    // Bez větve na fázi `request` by měřidlo tenhle případ spočítalo jako
    // úspěch: certifikátor ukázku zná jen jako korektní svět a pustí ji dál.
    const attempt = await driveCorpusCase(entry(), engineReplying([JSON.stringify(EXAMPLE_WORLD)]));

    expect(attempt.rounds[0]).toMatchObject({ stage: 'request', reason: 'EXAMPLE_COPY' });
    expect(scoreCorpusAttempt(entry(), attempt)).toMatchObject({
      verdict: 'FAULT',
      emissionValid: false,
      detail: 'request: EXAMPLE_COPY',
    });
  });

  it('rozpoznaná věta je jedno kolo a model se v ní nespustí', () => {
    const attempt = recognizerAttempt(entry(), OWN_WORLD);

    expect(attempt).toMatchObject({ source: 'recognizer', latencyMs: 0, error: '' });
    expect(attempt.rounds).toHaveLength(1);
    expect(scoreCorpusAttempt(entry(), attempt)).toMatchObject({ rounds: 1, firstRoundPassed: true });
  });
});

describe('histogram kol T4', () => {
  it('rozpad kol a přínos smyčky se čte z jednoho běhu, ne ze dvou', () => {
    const cases = [
      measured('P001', 'ROBUST', 'recognizer', true, 0, 1),
      measured('P002', 'ROBUST', 'model', true, 10, 1),
      measured('P003', 'FULFILLED', 'model', true, 60, 2),
      measured('P004', 'NO_FIT', 'model', true, 90, 3),
      measured('P005', 'FAULT', 'model', false, 100, 3),
    ];

    expect(summariseRounds(cases)).toEqual({
      histogram: { '1': 2, '2': 1, '3': 2 },
      passedFirstRound: 2,
      passedAfterRepair: 4,
      repaired: 2,
      gainPoints: 40,
    });
  });

  it('běh, ve kterém smyčka nic nezachránila, hlásí nulový přínos', () => {
    const cases = [
      measured('P001', 'ROBUST', 'model', true, 10, 1),
      measured('P002', 'FAULT', 'model', false, 100, 3),
    ];
    const summary = summariseRounds(cases);

    expect(summary).toMatchObject({ repaired: 0, gainPoints: 0, passedFirstRound: 1, passedAfterRepair: 1 });
  });

  it('report nese histogram a jde ho přepočítat z perSentence', () => {
    const cases = [measured('P001', 'ROBUST', 'model', true, 10, 2)];
    const report = buildCorpusReport({
      measuredAt: 'x',
      adapter: 'nvidia/ampere',
      model: 'test-model',
      manifestSha256: 'd'.repeat(64),
      cases,
    });

    expect(typeof report.rounds).toBe('object');
    expect(report.rounds.histogram).toEqual({ '2': 1 });
    expect(report.rounds).toMatchObject({ passedFirstRound: 0, passedAfterRepair: 1, repaired: 1, gainPoints: 100 });
  });
});

describe('kolo 1 je pořád tentýž požadavek jako dřív T4', () => {
  /**
   * Měřidlo si od 26. 8. 2026 nestaví prompt samo — staví ho `emitLocally()`.
   * Kdyby se ty dvě cesty rozešly, běh nad 200 větami by trval tři hodiny a
   * měřil by jiný prompt, než jaký měřil ten předchozí. Rozdíl by se přitom
   * projevil jen jako horší čísla, tedy jako výsledek, ne jako chyba.
   */
  it('emitLocally pošle v prvním kole přesně system a user ze zamčené věty', async () => {
    const entry = loadCorpusCases()[0]!;
    const sent: { system: string; user: string }[] = [];
    const engine: ChatEngine = {
      modelId: 'fake-model',
      async complete(system, user) {
        sent.push({ system, user });
        return { raw: '{}', finishReason: 'stop' };
      },
      async unload() {},
    };

    await driveCorpusCase(entry, engine);

    // Rozhoduje **první** volání. Další kola posílají prompt schválně jiný
    // (T4a: bez ukázky, s předchozí emisí), takže poslední volání by tuhle
    // vlastnost neměřilo.
    expect(sent[0]!.system).toBe(entry.system);
    expect(sent[0]!.user).toBe(entry.user);
    expect(sent[1]!.system.length).toBeLessThan(entry.system.length);
  });
});
