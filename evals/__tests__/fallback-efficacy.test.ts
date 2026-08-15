import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  denominatorOf,
  loadFloors,
  loadPrompts,
  measureEfficacy,
  sceneDrawCalls,
  PROTOCOL_PATH,
} from '../fallback-efficacy';
import { loadContracts } from '../scorer/semantic';
import { isUnder, listFiles } from '../../scripts/prove-fallback-isolation.mjs';

/**
 * Účinnost fallbacku nad zmrazenými prompty (P2 T205a).
 *
 * **Co tenhle soubor tvrdí a co netvrdí.** Netvrdí, že fallback podlahy splnil —
 * to je naměřený výsledek a jde do `evals/fallback-efficacy.json`, stejně jako
 * kill gate v T21 zapsal svoje čísla do reportu místo aby obarvil sadu. Tvrdí,
 * že **měření je poctivé**: jmenovatel je zmrazený, podlahy se čtou ze souboru,
 * každý případ se doopravdy odroutoval a odehrál, scéna se doopravdy postavila,
 * a verdikt počítá scorer z T16, ne tenhle soubor.
 *
 * Kdyby se sem napsalo `expect(report.passed).toBe(false)`, zamkla by se tím
 * naměřená vada jako požadovaný stav. Kdyby se napsalo `toBe(true)`, sada by
 * byla červená a nikdo by se k ostatním tvrzením nedostal. Ani jedno není
 * kontrola; obojí je poznámka pod čarou vydávaná za test.
 */

const REPORT_PATH = join(process.cwd(), 'evals', 'fallback-efficacy.json');

describe('evals/fallback-efficacy — jmenovatel a podlahy jsou zmrazené', () => {
  it('podlahy se čtou z protocol.v1.json, ne z konstanty vedle testu', () => {
    const onDisk = JSON.parse(readFileSync(PROTOCOL_PATH, 'utf8')) as {
      fallbackFloors: { minFulfilled: number; maxNoFitShare: number };
    };
    const floors = loadFloors();

    expect(floors.minFulfilled).toBe(onDisk.fallbackFloors.minFulfilled);
    expect(floors.maxNoFitShare).toBe(onDisk.fallbackFloors.maxNoFitShare);
    // Zdroj musí být `evals/frozen/`, jinak by si P2 podlahy nastavil sám.
    expect(PROTOCOL_PATH.replace(/\\/g, '/')).toContain('evals/frozen/protocol.v1.json');
  });

  it('jmenovatel je přísnější ze dvou čtení: createNonVacuous, tedy 11', () => {
    const contracts = loadContracts();
    const denominator = denominatorOf(contracts);
    const creates = contracts.filter((contract) => contract.kind === 'create');

    expect(denominator.map((contract) => contract.id)).toEqual([
      'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C14', 'C15',
    ]);
    // Volnější čtení („neprázdný vektor požadavků") by dalo 15. Bere se to
    // přísnější, protože strop NO_FIT je pak 2 z 11, ne 3 z 15.
    expect(creates.length).toBeGreaterThan(denominator.length);
    expect(denominator.length).toBeGreaterThanOrEqual(loadFloors().denominator.minDenominator);
  });

  it('každý kontrakt jmenovatele má zmrazený prompt', () => {
    const prompts = loadPrompts();
    for (const contract of denominatorOf(loadContracts())) {
      expect(prompts.get(contract.id), `${contract.id} nemá prompt`).toBeTruthy();
    }
  });
});

describe('evals/fallback-efficacy — měření je nevakuózní', () => {
  const report = measureEfficacy();

  it('žádný případ nekončí prázdnou obrazovkou', () => {
    // §13.4 platí i pro NO_FIT: odmítnutí se vztahuje na `sim`, nikdy na scénu.
    for (const entry of report.cases) {
      expect(entry.drawCalls, `${entry.id} nepostavil scénu ${entry.sceneLayout}`).toBeGreaterThan(0);
      expect(entry.detail, `${entry.id} nemá důvod`).not.toBe('');
    }
  });

  it('scéna je naměřená, ne prohlášená — neexistující layout dá nulu', () => {
    // Bez tohohle by `sceneDrawCalls` mohla vracet konstantu a `sceneBuilt` by
    // přestal být kontrola. Tohle je ta záporná větev.
    expect(sceneDrawCalls('layout-ktery-neexistuje')).toBe(0);
  });

  it('aspoň jeden zmrazený prompt se odroutuje a doběhne do výhry', () => {
    // Tohle je vlastní protijed na vakuózní fallback: sada, ve které by všech
    // 11 skončilo NO_FIT, by všechna ostatní tvrzení splnila.
    const played = report.cases.filter((entry) => entry.playedToWin);
    expect(played.length, 'žádný zmrazený prompt nedal dohranou partii').toBeGreaterThan(0);
  });

  it('měření je deterministické — dva běhy dají tentýž výsledek', () => {
    const again = measureEfficacy();
    expect(again.cases).toEqual(report.cases);
  });

  it('verdikt počítá scorer, ne tenhle modul: každý případ nese jeho slovník', () => {
    for (const entry of report.cases) {
      expect(['FULFILLED', 'ROBUST', 'NO_FIT', 'FAULT']).toContain(entry.verdict);
      // Verdikt musí odpovídat tomu, co fallback udělal. `declined` je ve
      // slovníku scoreru NO_FIT, `fault` je FAULT — kdyby se to rozešlo, měřilo
      // by se něco jiného, než co se stalo.
      if (entry.outcome === 'declined') expect(entry.verdict).toBe('NO_FIT');
      if (entry.outcome === 'fault') expect(entry.verdict).toBe('FAULT');
    }
  });

  it('součty sedí s jednotlivými případy', () => {
    const sum = report.fulfilled + report.robust + report.noFit + report.fault;
    expect(sum).toBe(report.denominator);
    expect(report.noFitShare).toBeCloseTo(report.noFit / report.denominator, 10);
    expect(report.passes.minFulfilled).toBe(report.fulfilled >= report.floors.minFulfilled);
    expect(report.passes.maxNoFitShare).toBe(report.noFitShare <= report.floors.maxNoFitShare);
  });

  it('zapíše report, ať podlahy prošly nebo ne', () => {
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    const written = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as { passed: boolean };
    expect(written.passed).toBe(report.passed);
  });
});

describe('evals/fallback-efficacy — izolace z T204 drží', () => {
  it('scorer ani evals nejsou importované ze src/fallback ani ze src/kit', () => {
    // AC to žádá jmenovitě. Sémantický scorer sahá na `src/ir`, `src/sim`,
    // `src/verify` i `src/patch`; jediný import odsud do fallbacku by ho vtáhl
    // do tranzitivního obalu jádra a `prove-fallback-isolation.mjs` by skončil
    // na „fallback sahá na jádro".
    const guarded = listFiles('').filter(
      (file) =>
        isUnder(file, ['src/fallback', 'src/kit', 'src/app/fallback']) &&
        ['.ts', '.tsx', '.mts'].some((ext) => file.endsWith(ext)),
    );
    expect(guarded.length).toBeGreaterThan(0);

    const offenders = guarded.filter((file) =>
      /from\s*['"][^'"]*(evals\/|scorer\/)/.test(readFileSync(join(process.cwd(), file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
