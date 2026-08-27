import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { HOSTILE_BUCKETS, readCorpus } from '../corpus-v3/lock.mjs';
import {
  measureHostile,
  violationsOf,
  REPORT_PATH,
  WAIT_BUDGET_MS,
  type HostileCase,
  type HostileReport,
} from '../measure-hostile';

/**
 * Běžec měření z T20 — `npm run measure:hostile`.
 *
 * **Report se zapisuje dřív, než se cokoli tvrdí.** AC žádá dvě věci najednou:
 * aby artefakt vznikl a aby běh při porušení skončil nenulově. Kdyby se zapisoval
 * až nakonec, první porušení by běh zabilo a soubor, ve kterém je vidět co se
 * stalo, by nevznikl — tedy přesně ve chvíli, kdy je nejvíc potřeba.
 *
 * **Co tenhle soubor tvrdí.** Tři zákazy z AC (prázdná scéna, výjimka, čekání nad
 * 20 s) a že se měřilo nad celou nepřátelskou podmnožinou, ne nad její částí.
 * Že se korpus od zamčení nehnul, dokazuje `corpus-v3-frozen.test.ts` — odsud se
 * to dokázat nedá, viz hlavička `evals/measure-hostile.ts`.
 *
 * **Co netvrdí.** Kolik vět skončí náhradní místností. To je naměřený stav a jde
 * do reportu; jako aserce by z dnešního poměru udělal požadavek.
 */

const ARTIFACT = join(process.cwd(), REPORT_PATH);

describe('evals/measure-hostile — nepřátelská věta nikdy nedá prázdnou scénu', () => {
  let report: HostileReport;

  beforeAll(() => {
    report = measureHostile();
    writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  });

  it('vyrobí report na dohodnuté cestě', () => {
    const written = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as HostileReport;
    expect(written.total).toBe(report.total);
    expect(written.violations).toEqual(report.violations);
  });

  it('měří celou nepřátelskou podmnožinu, ne její část', () => {
    // Podmnožina se odvozuje z korpusu podruhé, nezávisle na měření. Bez toho by
    // běh nad prázdným výběrem prošel všemi zákazy níž naprázdno.
    const expected = readCorpus().prompts.filter((prompt) => HOSTILE_BUCKETS.includes(prompt.bucket));
    expect(expected.length).toBeGreaterThan(0);
    expect(report.total).toBe(expected.length);
    expect(report.cases.map((entry) => entry.id)).toEqual(expected.map((prompt) => prompt.id));
    expect(new Set(report.cases.map((entry) => entry.bucket))).toEqual(new Set(HOSTILE_BUCKETS));
  });

  it('nula případů skončí prázdnou scénou', () => {
    expect(report.violations.emptyScene).toEqual([]);
    for (const entry of report.cases) expect(entry.entities, entry.id).toBeGreaterThan(0);
  });

  it('nula případů skončí neošetřenou výjimkou', () => {
    expect(report.violations.threw).toEqual([]);
  });

  it('nula případů čeká déle než 20 s', () => {
    expect(report.violations.overBudget).toEqual([]);
    expect(report.slowestMs).toBeLessThanOrEqual(WAIT_BUDGET_MS);
    expect(report.waitBudgetMs).toBe(WAIT_BUDGET_MS);
  });

  it('každý svět má původ, a náhrada nese vadu', () => {
    // Slib záruky zvenčí: nic se nezametlo. Tichá náhrada by prošla zákazem
    // prázdné scény a tvářila se jako pochopená věta.
    for (const entry of report.cases) {
      expect(entry.kind, entry.id).not.toBeNull();
      if (entry.kind === 'seed') expect(entry.fault, entry.id).not.toBeNull();
      else expect(entry.fault, entry.id).toBeNull();
    }
    expect(report.byOrigin.shape + report.byOrigin.seed + report.byOrigin.threw).toBe(report.total);
    expect(Object.values(report.faults).reduce((sum, count) => sum + count, 0)).toBe(report.byOrigin.seed);
  });

  it('zákazy doopravdy koušou — nad vymyšleným porušením se rozsvítí', () => {
    // Brána, která umí selhat jen nad skutečným během, se nedá dokázat. Tohle je
    // ta druhá polovina: tři vadné případy, tři různé zákazy, žádný neprojde.
    const fabricated: HostileCase[] = [
      { ...TEMPLATE, id: 'X1', entities: 0, emptyScene: true },
      { ...TEMPLATE, id: 'X2', threw: 'Error: spadlo to' },
      { ...TEMPLATE, id: 'X3', ms: WAIT_BUDGET_MS + 1, overBudget: true },
    ];
    expect(violationsOf(fabricated)).toEqual({
      emptyScene: ['X1'],
      threw: ['X2'],
      overBudget: ['X3'],
    });
    expect(violationsOf([TEMPLATE])).toEqual({ emptyScene: [], threw: [], overBudget: [] });
  });
});

/** Bezvadný případ. Vymyšlená porušení se z něj skládají po jednom. */
const TEMPLATE: HostileCase = {
  id: 'X0',
  bucket: 'nonsense',
  text: 'asdfghjkl',
  kind: 'seed',
  shapeId: null,
  fault: 'NO_SHAPE',
  entities: 3,
  emptyScene: false,
  winnable: true,
  threw: null,
  ms: 1,
  overBudget: false,
};
