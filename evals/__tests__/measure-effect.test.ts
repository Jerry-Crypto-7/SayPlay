/**
 * **Brána nad měřidlem druhé věty** (P15 T40).
 *
 * Měřidlo, které porovnává svět sám se sebou, vrátí „nic se nezměnilo" u všeho a
 * měřidlo, které porovnává dokument místo běhu, vrátí „změnilo se všechno". Obě
 * vypadají zvenčí jako funkční číslo, takže se tady soudí připíchnutými
 * hodnotami: konkrétní `visibleChangeRate`, konkrétní hash základního běhu a
 * jmenovitá mapa „který případ se pohnul". Když se některé z těch čísel hne,
 * má se to ozvat a má se zapsat proč — ne se přepsat.
 *
 * Sada **nezapisuje** `evals/effect-rate.json`; zapisuje ho jen přímé spuštění
 * skriptu. Commitnutý report se tu jen porovnává, takže `npx vitest run evals`
 * nemá jak vyrobit tichý pohyb v commitnutém artefaktu.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { sealSimHash } from '@/ir/worlddoc';

import {
  CASES,
  HORIZON_TICKS,
  REPORT_PATH,
  baseWorld,
  measureCase,
  measureEffect,
  movedAfterHorizon,
  planOf,
  stateAfter,
} from '../measure-effect';

/**
 * Naměřeno 3. 9. 2026 nad sadou devíti vět. Pět z devíti pohne hashovaným stavem
 * do dvaceti tiků; tři z nich jsou negativní dvojice, které se pohnout nesmějí,
 * a jedna (`gate-open`) je změna, kterou žádné pravidlo nečte.
 */
const PINNED = {
  total: 9,
  moved: 5,
  visibleChangeRate: 0.5556,
  movesRate: 0.8333,
  baselineHash: '9e810ea2',
} as const;

/** Který případ se pohnul. Jmenovitě, ne počtem — počet přežije prohození dvou řádků. */
const PINNED_MOVED: Readonly<Record<string, boolean>> = {
  'keys-init': true,
  'exit-socket': true,
  'spawn-socket': true,
  'exit-unlocked': true,
  'gate-tally': true,
  'gate-open': false,
  palette: false,
  'light-and-air': false,
  'gate-module': false,
};

const report = measureEffect();

describe('sada druhých vět', () => {
  it('každý případ je legální emise refineru, ne jen hromádka operací', () => {
    for (const entry of CASES) {
      const plan = planOf(entry);
      expect(plan.stableId, entry.id).toBe(entry.target.stableId);
      expect(plan.summary.length, entry.id).toBeGreaterThan(0);
    }
  });

  it('negativní dvojice v sadě JE a je vzhledová', () => {
    // Bez tohohle testu se dá sada „zlepšit" smazáním nepohodlných řádků a
    // měřidlo pak nemá jak selhat. Fasety se soudí zvlášť, protože nulová
    // vzhledová operace by z negativní dvojice udělala prázdnou změnu, která
    // taky nic nepohne — a to by byla jiná, bezcenná nula.
    const inert = CASES.filter((entry) => entry.intent === 'inert');
    expect(inert.length).toBeGreaterThan(0);

    for (const entry of inert) {
      const plan = planOf(entry);
      expect(plan.appearance.length, entry.id).toBeGreaterThan(0);
      expect(plan.behavior, entry.id).toHaveLength(0);
    }

    for (const entry of CASES.filter((one) => one.intent === 'moves')) {
      const plan = planOf(entry);
      expect(plan.behavior.length, entry.id).toBeGreaterThan(0);
      expect(plan.appearance, entry.id).toHaveLength(0);
    }
  });
});

describe('měřidlo umí říct obojí', () => {
  it('svět srovnaný sám se sebou se nepohne', () => {
    // Tohle je celý důvod, proč `movedAfterHorizon` bere obě strany parametrem:
    // kdyby si základ bral zevnitř, tvrzení by nešlo vyzkoušet a mutace, která
    // obě strany slije do jedné, by prošla celou sadou.
    const base = baseWorld();
    expect(movedAfterHorizon(base, base)).toBe(false);
  });

  it('svět se změněným pravidlem se pohne', () => {
    const base = baseWorld();
    const changed = sealSimHash({
      ...base,
      simRevision: base.simRevision + 1,
      simHash: '',
      sim: { ...base.sim, sockets: { spawn: [1, 1], gate: [12, 1], exit: [4, 3] } },
    });
    expect(movedAfterHorizon(base, changed)).toBe(true);
  });

  it('základní svět do horizontu NEdoběhne — jinak by měřidlo osleplo', () => {
    // Dvě cesty, které se sejdou ve výhře, mají tentýž koncový stav. Kdyby
    // základ vyhrával do dvaceti tiků, `spawn-socket` i `exit-socket` by vyšly
    // nula a měřidlo by tvrdilo, že druhá věta svět nemění.
    const base = baseWorld();
    expect(stateAfter(base, HORIZON_TICKS).runState).toBe('running');
    expect(stateAfter(base, HORIZON_TICKS).tick).toBe(HORIZON_TICKS);
    expect(stateAfter(base, 60).runState).toBe('won');
  });

  it('měří se hashovaný stav běhu, ne hash dokumentu', () => {
    // `gate-open` je ten rozdíl v jednom případu: dokument se změní (a `simHash`
    // s ním), ale žádné pravidlo stav brány nečte, takže se běh chová stejně.
    // Měřidlo postavené na `simHash` by tady vrátilo `true` a tenhle test by
    // zčervenal — což je přesně jeho úkol.
    const base = baseWorld();
    const entry = CASES.find((one) => one.id === 'gate-open');
    expect(entry).toBeDefined();

    const measured = measureCase(entry!, base);
    expect(measured.outcome).toBe('CERTIFIED');
    expect(measured.moved).toBe(false);
  });
});

describe('naměřená čísla', () => {
  it('drží připíchnuté hodnoty', () => {
    expect(report.horizonTicks).toBe(HORIZON_TICKS);
    expect(report.total).toBe(PINNED.total);
    expect(report.moved).toBe(PINNED.moved);
    expect(report.visibleChangeRate).toBe(PINNED.visibleChangeRate);
    expect(report.byIntent.moves.rate).toBe(PINNED.movesRate);
    expect(report.baseline.hash).toBe(PINNED.baselineHash);
  });

  it('negativní dvojice vychází nula, jmenovitě u každého případu', () => {
    expect(report.byIntent.inert.total).toBeGreaterThan(0);
    expect(report.byIntent.inert.moved).toBe(0);
    expect(report.byIntent.inert.rate).toBe(0);

    for (const measured of report.cases.filter((one) => one.intent === 'inert')) {
      expect(measured.outcome, measured.id).toBe('CERTIFIED');
      expect(measured.moved, measured.id).toBe(false);
    }
  });

  it('každý případ se pohnul přesně tak, jak je připíchnuto', () => {
    const measured = Object.fromEntries(report.cases.map((one) => [one.id, one.moved]));
    expect(measured).toEqual(PINNED_MOVED);
  });

  it('žádný případ nespadl na patch řetězu — odmítnutí by měřilo fixturu, ne svět', () => {
    for (const one of report.cases) expect(one.rejection, one.id).toBeNull();
  });
});

describe('commitnutý report', () => {
  it('je totožný s čerstvým měřením', () => {
    // Report nemá časové razítko schválně, takže se dá porovnat celý. Kdyby ho
    // měl, tenhle test by musel pole vyzobávat a rozdíl by se v něm dal schovat.
    const committed = JSON.parse(readFileSync(REPORT_PATH, 'utf-8')) as unknown;
    expect(committed).toEqual(JSON.parse(JSON.stringify(report)));
  });
});
