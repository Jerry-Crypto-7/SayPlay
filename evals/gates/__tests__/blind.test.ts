/**
 * Slepý běh a statistická vrstva (T706) – testy obou modulů úlohy.
 *
 * Nosné vlastnosti jsou dvě a obě se dají porušit tiše:
 *
 * 1. **Vyhodnocovací vstup nesmí nést identifikátor varianty.** Zaslepení, které
 *    odstraní štítek nahoře a nechá ho zanořený v payloadu, projde každou
 *    povrchní kontrolou. Testy proto útočí na hloubku, na jména klíčů i na
 *    pořadí – pozice prozradí rameno stejně dobře jako slovo.
 * 2. **Nic se nedopočítává.** Clusterovaný interval je vstup a musí se
 *    reprodukovat ze zmrazeného seedu; neúplný běh nemá míru úspěšnosti vůbec,
 *    ne jen širší mez.
 *
 * Syntetické sondy vznikají klonem naměřeného reportu a jeho mutací – ručně
 * psaná fixtura by byla druhý zdroj pravdy o tvaru `KillGateReport`.
 */
import { describe, expect, it } from 'vitest';

import { statsProtocol } from '../../harness/cluster';
import { aggregateGates, type KillGateReport } from '../../harness/kill-gate';
import { ArmLeakError, armLeaks, blind, blindKillGate, unblind, type LabelledItem } from '../blind';
import { loadKillGateReport } from '../run/kill-gate';
import { CLUSTER_SOURCE, gateStatistics } from '../stats';

const report = loadKillGateReport();
const protocol = statsProtocol();
const gates = aggregateGates();

/** Sůl je vstup běhu, ne konstanta protokolu – viz hlavička `blind.ts`. */
const SALT = 'T706-slepy-beh';

/** Klon, na kterém se smí mutovat – `report` je readonly a sdílený. */
function clone(): KillGateReport {
  return JSON.parse(JSON.stringify(report)) as KillGateReport;
}

/** Zápis do klonu. Typy reportu jsou readonly schválně; mutuje jen test. */
function mutable(source: KillGateReport): {
  complete: boolean;
  completedCases: number;
  incompleteReason: string | null;
  clustered: { interval: { lower: number; upper: number; seed: number } };
  perClassFloors: { classId: string }[];
} {
  return source as unknown as ReturnType<typeof mutable>;
}

const PAYLOAD_KEYS = ['rawHash', 'repairs', 'structuralFailures'];

describe('slepý běh nad populací brány', () => {
  const run = blindKillGate(report, SALT);

  it('nese každý případ právě jednou a pod neprůhlednou rukojetí', () => {
    expect(run.items).toHaveLength(report.cases.length);
    expect(run.key.assignments).toHaveLength(report.cases.length);
    expect(new Set(run.items.map((item) => item.handle)).size).toBe(report.cases.length);
    for (const item of run.items) expect(item.handle).toMatch(/^b\d{2}$/);
  });

  it('vyhodnocovací vstup neobsahuje identifikátor varianty', () => {
    expect(armLeaks(run.items, run.key.arms)).toEqual([]);
    expect(run.key.arms).toEqual(['create', 'edit']);

    const serialised = JSON.stringify(run.items).toLowerCase();
    for (const arm of run.key.arms) expect(serialised).not.toContain(arm);
  });

  it('a nenese ani id, cestu k odpovědi, ani hotový verdikt', () => {
    for (const item of run.items) {
      expect(Object.keys(item.payload as object).sort()).toEqual([...PAYLOAD_KEYS].sort());
    }
  });

  it('pořadí je zamíchané, takže variantu neprozradí ani pozice', () => {
    const armsInHandleOrder = run.key.assignments.map((assignment) => assignment.arm);
    // Vstup chodí seskupený: nejdřív celá tvorba, pak celá editace. Setříděná
    // podoba je tedy přesně to, co by zbylo, kdyby se zamíchání vypustilo.
    expect(armsInHandleOrder).not.toEqual([...armsInHandleOrder].sort());
    expect(run.key.assignments.map((assignment) => assignment.caseId)).not.toEqual(
      report.cases.map((candidate) => candidate.id),
    );
  });

  it('táž sůl dá totéž přiřazení, jiná sůl jiné', () => {
    expect(blindKillGate(report, SALT).key.assignments).toEqual(run.key.assignments);
    expect(blindKillGate(report, `${SALT}-jina`).key.assignments).not.toEqual(run.key.assignments);
  });

  it('prázdná sůl je odmítnutí', () => {
    expect(() => blindKillGate(report, '   ')).toThrow(/bez soli/);
  });

  it('jediná varianta se nezaslepuje', () => {
    const oneArm: readonly LabelledItem[] = report.cases
      .filter((candidate) => candidate.branch === 'create')
      .map((candidate) => ({ caseId: candidate.id, arm: candidate.branch, payload: { repairs: candidate.repairs } }));
    expect(() => blind(oneArm, SALT)).toThrow(/jedinou variantou/);
  });

  it('týž záznam dvakrát je odmítnutí', () => {
    const twice: readonly LabelledItem[] = [
      { caseId: 'X1', arm: 'a', payload: {} },
      { caseId: 'X1', arm: 'b', payload: {} },
    ];
    expect(() => blind(twice, SALT)).toThrow(/dvakrát/);
  });

  it('prázdný vstup je odmítnutí', () => {
    expect(() => blind([], SALT)).toThrow(/prázdný/);
  });
});

describe('hledání úniku varianty', () => {
  it('najde jméno ramene zanořené uvnitř payloadu', () => {
    const leaky: readonly LabelledItem[] = [
      { caseId: 'X1', arm: 'create', payload: { meta: { origin: ['větev: create'] } } },
      { caseId: 'X2', arm: 'edit', payload: { meta: { origin: ['bez štítku'] } } },
    ];
    expect(() => blind(leaky, SALT)).toThrow(ArmLeakError);

    const found = armLeaks([{ handle: 'b1', payload: leaky[0].payload }], ['create', 'edit']);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('payload.meta.origin[0]');
    expect(found[0].token).toBe('create');
  });

  it('najde jméno ramene ve jménu klíče, ne jen v hodnotě', () => {
    const leaky: readonly LabelledItem[] = [
      { caseId: 'X1', arm: 'create', payload: { createdBy: 1 } },
      { caseId: 'X2', arm: 'edit', payload: { autor: 1 } },
    ];
    expect(() => blind(leaky, SALT)).toThrow(ArmLeakError);
    expect(armLeaks([{ handle: 'b1', payload: leaky[0].payload }], ['create'])[0].path).toBe('payload.createdBy');
  });

  it('nehlásí nic tam, kde jméno ramene není', () => {
    expect(armLeaks([{ handle: 'b1', payload: { a: 'nic', b: [1, 2, null], c: { d: true } } }], ['create', 'edit'])).toEqual(
      [],
    );
  });
});

describe('odslepení', () => {
  const run = blindKillGate(report, SALT);
  const verdicts = run.key.assignments.map((assignment) => ({
    handle: assignment.handle,
    success: assignment.arm === 'edit',
  }));

  it('vrátí každý případ jeho variantě a setříděně podle id', () => {
    const back = unblind(verdicts, run.key);
    expect(back).toHaveLength(report.cases.length);
    expect(back.map((outcome) => outcome.id)).toEqual([...back.map((outcome) => outcome.id)].sort());

    const byId = new Map(back.map((outcome) => [outcome.id, outcome]));
    for (const candidate of report.cases) {
      expect(byId.get(candidate.id)?.arm).toBe(candidate.branch);
      expect(byId.get(candidate.id)?.success).toBe(candidate.branch === 'edit');
    }
  });

  it('odmítne neznámou rukojeť', () => {
    expect(() => unblind([...verdicts, { handle: 'b99', success: true }], run.key)).toThrow(/v klíči není/);
  });

  it('odmítne tutéž rukojeť dvakrát', () => {
    expect(() => unblind([...verdicts, verdicts[0]], run.key)).toThrow(/dvakrát/);
  });

  it('odmítne neúplnou sadu verdiktů místo dopočtu', () => {
    expect(() => unblind(verdicts.slice(1), run.key)).toThrow(/neúplné/);
  });
});

describe('clusterovaný interval je vstup, ne nová veličina', () => {
  const stats = gateStatistics(report, protocol);

  it('přebírá se z reportu a hlásí se to', () => {
    expect(stats.clustered.mintedHere).toBe(false);
    expect(stats.clustered.source).toBe(CLUSTER_SOURCE);
    expect(stats.clustered.interval).toEqual(report.clustered.interval);
    expect(stats.clustered.clusters).toBe(report.corpus.clusters);
    expect(stats.clustered.meetsClusterFloor).toBe(true);
  });

  it('a reprodukuje se bootstrapem ze zmrazeného seedu', () => {
    expect(report.clustered.interval.seed).toBe(protocol.bootstrapSeed);
    expect(stats.clustered.reproduced).toBe(true);
    expect(stats.clustered.reproducedInterval.lower).toBe(report.clustered.interval.lower);
    expect(stats.clustered.reproducedInterval.upper).toBe(report.clustered.interval.upper);
  });

  // Obě meze zvlášť: aserce jen nad dolní mezí nechá horní bez ochrany a
  // podvržený strop intervalu projde. Naměřeno mutací, ne odhadnuto.
  it.each([
    ['dolní', (forged: KillGateReport) => (mutable(forged).clustered.interval.lower = 0.5)],
    ['horní', (forged: KillGateReport) => (mutable(forged).clustered.interval.upper = 0.9)],
  ])('podvržená %s mez se nereprodukuje a shodí publikovatelnost', (_which, forge) => {
    const forged = clone();
    forge(forged);
    const forgedStats = gateStatistics(forged, protocol);
    expect(forgedStats.clustered.reproduced).toBe(false);
    expect(forgedStats.publishable).toBe(false);
    expect(forgedStats.publishableReasons.join(' ')).toMatch(/nereprodukuje/);
  });

  it('podvržený seed se nereprodukuje ani tehdy, když meze sedí', () => {
    const forged = clone();
    mutable(forged).clustered.interval.seed = protocol.bootstrapSeed + 1;
    expect(gateStatistics(forged, protocol).clustered.reproduced).toBe(false);
  });
});

describe('neúplný běh se vykazuje jako neúplný', () => {
  const partial = clone();
  mutable(partial).complete = false;
  mutable(partial).completedCases = 20;
  mutable(partial).incompleteReason = 'strop útraty';
  const stats = gateStatistics(partial, protocol);

  it('žádná míra úspěšnosti se nepočítá', () => {
    for (const rate of stats.rates) {
      expect(rate.status, rate.id).toBe('INCOMPLETE');
      expect(rate.rate, rate.id).toBeNull();
      expect(rate.wilson, rate.id).toBeNull();
      expect(rate.meetsFloor, rate.id).toBeNull();
      expect(rate.claimable, rate.id).toBe(false);
      expect(rate.note).toContain('strop útraty');
    }
  });

  it('naměřený zlomek ale zůstává vidět – data nejsou tvrzení', () => {
    for (const rate of stats.rates) expect(rate.trials).toBe(report.completedCases);
  });

  it('a totéž platí pro podlahy po třídách', () => {
    for (const row of stats.classFloors) {
      expect(row.status, row.classId).toBe('INCOMPLETE');
      expect(row.rate, row.classId).toBeNull();
      expect(row.wilson, row.classId).toBeNull();
      expect(row.enforced, row.classId).toBe(false);
    }
    expect(stats.enforcedClassFloors).toBe(0);
    expect(stats.publishable).toBe(false);
    expect(stats.publishableReasons.join(' ')).toContain('strop útraty');
  });
});

describe('podlahy po třídách se vykazují zvlášť', () => {
  const stats = gateStatistics(report, protocol);

  it('jsou všechny třídy protokolu, v jeho pořadí', () => {
    expect(stats.classFloors.map((row) => row.classId)).toEqual(protocol.classes.map((editClass) => editClass.id));
  });

  it('podlaha i gating jmenovatel jsou ze zmrazeného protokolu', () => {
    for (const row of stats.classFloors) {
      const frozen = protocol.classes.find((editClass) => editClass.id === row.classId);
      expect(frozen, row.classId).toBeDefined();
      expect(row.floor).toBe(frozen?.rawPassFloor);
      expect(row.minDenominator).toBe(protocol.minDenominatorForFloor);
    }
  });

  it('žádná nehradí, protože jmenovatele jsou pod minimem', () => {
    for (const row of stats.classFloors) {
      expect(row.trials, row.classId).toBeLessThan(protocol.minDenominatorForFloor);
      expect(row.enforced, row.classId).toBe(false);
    }
    expect(stats.enforcedClassFloors).toBe(0);
  });

  /**
   * Naměřené jmenovatele jsou 1–3, takže hradící větev by se nad reálným
   * reportem nikdy neprovedla a její test by byl dekorace. Sonda si proto
   * jmenovatel dodá sama – týž postup, jakým `cluster.ts` testuje
   * `assertClassFloors`.
   */
  it('hradí, jakmile je jmenovatel dost velký – ale jen u úplného běhu', () => {
    const big = clone();
    const row = mutable(big).perClassFloors[0] as unknown as {
      trials: number;
      successes: number;
    };
    row.trials = protocol.minDenominatorForFloor;
    row.successes = protocol.minDenominatorForFloor;

    const complete = gateStatistics(big, protocol);
    expect(complete.classFloors[0].enforced).toBe(true);
    expect(complete.classFloors[0].meetsFloor).toBe(true);
    expect(complete.enforcedClassFloors).toBe(1);

    mutable(big).complete = false;
    expect(gateStatistics(big, protocol).classFloors[0].enforced).toBe(false);
    expect(gateStatistics(big, protocol).enforcedClassFloors).toBe(0);
  });

  it('chybějící třída je odmítnutí, ne prázdný řádek', () => {
    const trimmed = clone();
    mutable(trimmed).perClassFloors = mutable(trimmed).perClassFloors.slice(1);
    expect(() => gateStatistics(trimmed, protocol)).toThrow(/neuvádí třídu/);
  });

  it('třída, kterou protokol nezná, je odmítnutí taky', () => {
    const invented = clone();
    const rows = mutable(invented).perClassFloors;
    rows.push({ ...rows[0], classId: 'vymyslena_trida' });
    expect(() => gateStatistics(invented, protocol)).toThrow(/nezná/);
  });
});

describe('agregátní míry a razítko běhu', () => {
  const stats = gateStatistics(report, protocol);

  it('jsou tři, ve stejném pořadí jako v reportu', () => {
    expect(stats.rates.map((rate) => rate.id)).toEqual([
      report.fulfilledRate.id,
      report.rawPatchPassRate.id,
      report.firstRequestCommitRate.id,
    ]);
  });

  it('Wilsonova mez se počítá tímtéž vzorcem jako v reportu', () => {
    const blocks = [report.fulfilledRate, report.rawPatchPassRate, report.firstRequestCommitRate];
    for (const rate of stats.rates) {
      const block = blocks.find((candidate) => candidate.id === rate.id);
      expect(rate.wilson, rate.id).toEqual(block?.wilson);
    }
  });

  it('rawPatchPassRate padá proti zmrazenému prahu', () => {
    const raw = stats.rates.find((rate) => rate.id === report.rawPatchPassRate.id);
    expect(raw?.floor).toBe(gates.rawPatchPassRate.floor);
    expect(raw?.meetsFloor).toBe(false);
    expect(raw?.status).toBe('MEASURED');
  });

  it('vývojové razítko drží publikovatelnost dole i u úplného běhu', () => {
    expect(report.complete).toBe(true);
    expect(stats.publishable).toBe(false);
    expect(stats.publishableReasons).toHaveLength(1);
    expect(stats.publishableReasons[0]).toContain(report.gate.grade);
  });

  it('a žádná míra se nehlásí jako citovatelná', () => {
    for (const rate of stats.rates) expect(rate.claimable, rate.id).toBe(false);
  });
});
