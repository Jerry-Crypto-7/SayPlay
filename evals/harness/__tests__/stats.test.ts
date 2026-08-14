/**
 * Statistická vrstva (T20): Wilsonova mez, clustery podle identity světa,
 * třídní podlahy.
 *
 * ## Odkud jsou referenční čísla
 *
 * Tabulka `STATSMODELS_95` a `STATSMODELS_99` **není** dopočítaná týmž vzorcem,
 * který se testuje — to by dokazovalo jen to, že vzorec se rovná sám sobě.
 * Vygeneroval ji `statsmodels.stats.proportion.proportion_confint(x, n,
 * alpha, method='wilson')` ve verzi 0.14.6 (scipy 1.17.0), tedy nezávislá
 * implementace mimo tenhle repozitář. Řádek `[93, 100, …]` navíc sedí s číslem,
 * které si zmrazený protokol píše sám v `aggregateGates.wilsonCaveat`
 * („dolní mez jen 86,2 %"), takže reference souhlasí i s dokumentem.
 *
 * Druhá, na tvaru nezávislá kontrola je `skóre`: obě meze musí být kořeny
 * rovnice |p̂ − p| = z·√(p(1−p)/n). Ta se počítá z vrácené hodnoty zpátky, takže
 * překlep v uzavřeném tvaru neprojde ani kdyby se referenční tabulka ztratila.
 */

import { describe, expect, it } from 'vitest';

import {
  ClusterFloorError,
  FloorViolationError,
  assertClassFloors,
  assertClusterFloor,
  classAggregates,
  clusterBootstrap,
  clusterStandardError,
  clusteredRate,
  clustersOf,
  frozenClassification,
  statsProtocol,
  type Classification,
  type Cluster,
  type Outcome,
  type StatsProtocol,
} from '../cluster';
import { Z_95, wilsonInterval } from '../wilson';

const TOLERANCE = 1e-9;

const near = (actual: number, expected: number, tolerance = TOLERANCE): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
};

// ---------------------------------------------------------------------------
// Wilson
// ---------------------------------------------------------------------------

/** `[successes, trials, lower, upper]` — statsmodels 0.14.6, alpha = 0,05. */
const STATSMODELS_95: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 0.0, 0.7934506856227627],
  [1, 1, 0.2065493143772374, 1.0],
  [0, 10, 0.0, 0.27753279986288926],
  [1, 10, 0.017876213095072924, 0.40415002679523854],
  [5, 10, 0.23659309051256394, 0.7634069094874361],
  [9, 10, 0.5958499732047614, 0.982123786904927],
  [10, 10, 0.7224672001371106, 1.0],
  [3, 3, 0.43850296824495444, 1.0],
  [2, 3, 0.2076596008020477, 0.9385080552796037],
  [4, 7, 0.2504583645276572, 0.8417801447485302],
  [2, 25, 0.02222040128484759, 0.24966108950395322],
  [17, 25, 0.4841026927310224, 0.8279480969309203],
  [6, 40, 0.07061187717320357, 0.2907232436648971],
  [24, 40, 0.44595893660346186, 0.7365167431570808],
  [93, 100, 0.862504852609265, 0.9656807389327274],
  [100, 100, 0.9630065017930143, 1.0],
  [1, 1000, 0.00017654637062607765, 0.005642558597957937],
  [288, 300, 0.9313957879613599, 0.9769726785120576],
];

const Z_99 = 2.5758293035489004;

const STATSMODELS_99: readonly (readonly [number, number, number, number])[] = [
  [93, 100, 0.8342060485588548, 0.9722841600055375],
  [24, 40, 0.40044057696516194, 0.7711047803333211],
  [5, 10, 0.1842255182472355, 0.8157744817527646],
];

describe('Wilsonova mez', () => {
  it('reprodukuje referenční meze v toleranci 1e-9', () => {
    for (const [successes, trials, lower, upper] of STATSMODELS_95) {
      const interval = wilsonInterval(successes, trials);
      near(interval.lower, lower);
      near(interval.upper, upper);
      near(interval.point, successes / trials);
    }
  });

  it('bere kritickou hodnotu jako parametr, ne jako konstantu', () => {
    for (const [successes, trials, lower, upper] of STATSMODELS_99) {
      const interval = wilsonInterval(successes, trials, Z_99);
      near(interval.lower, lower);
      near(interval.upper, upper);
      expect(interval.z).toBe(Z_99);
    }

    // Přísnější hladina musí dát širší interval — jinak se parametr někde ztratil.
    const wide = wilsonInterval(93, 100, Z_99);
    const narrow = wilsonInterval(93, 100);
    expect(wide.lower).toBeLessThan(narrow.lower);
    expect(wide.upper).toBeGreaterThan(narrow.upper);
  });

  it('vrací kořeny skórové rovnice, ne jen shodu s tabulkou', () => {
    for (let trials = 1; trials <= 60; trials += 1) {
      for (let successes = 0; successes <= trials; successes += 1) {
        const { lower, upper, point } = wilsonInterval(successes, trials);
        for (const bound of [lower, upper]) {
          if (bound <= 0 || bound >= 1) continue; // mez uříznutá na hranici kořen nemá
          const score = Math.abs(point - bound) / Math.sqrt((bound * (1 - bound)) / trials);
          near(score, Z_95);
        }
      }
    }
  });

  it('je zrcadlová: dolní mez x je doplňkem horní meze n−x', () => {
    for (const [successes, trials] of STATSMODELS_95) {
      const left = wilsonInterval(successes, trials);
      const right = wilsonInterval(trials - successes, trials);
      near(left.lower, 1 - right.upper, 1e-12);
      near(left.upper, 1 - right.lower, 1e-12);
    }
  });

  it('nedovolí mez mimo <0, 1> ani u krajních hodnot', () => {
    for (const trials of [1, 3, 10, 100, 1000]) {
      for (const successes of [0, trials]) {
        const { lower, upper } = wilsonInterval(successes, trials);
        expect(lower).toBeGreaterThanOrEqual(0);
        expect(upper).toBeLessThanOrEqual(1);
      }
      expect(wilsonInterval(0, trials).lower).toBe(0);
      expect(wilsonInterval(trials, trials).upper).toBe(1);
    }
  });

  it('odmítne prázdný jmenovatel i nesmyslný čitatel', () => {
    expect(() => wilsonInterval(0, 0)).toThrow(RangeError);
    expect(() => wilsonInterval(0, -1)).toThrow(RangeError);
    expect(() => wilsonInterval(3, 2)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(5, 10, 0)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Zmrazený korpus jako vstup
// ---------------------------------------------------------------------------

const CORPUS = frozenClassification();
const PROTOCOL = statsProtocol();

const ids = (branch?: 'create' | 'edit'): readonly string[] =>
  [...CORPUS.values()].filter((row) => branch === undefined || row.branch === branch).map((row) => row.id);

/** Každý záznam dostane vlastní objekt, aby šlo ověřit, že si ho agregát drží. */
const outcomesFor = (list: readonly string[], succeeds: (id: string) => boolean): readonly Outcome[] =>
  list.map((id) => ({ id, success: succeeds(id), record: { id, note: `surový záznam ${id}` } }));

describe('identita světa', () => {
  it('dá z korpusu 15 clusterů, po jednom na create prompt', () => {
    const clusters = clustersOf(outcomesFor(ids(), () => true));
    expect(clusters).toHaveLength(15);
    expect(clusters.reduce((sum, cluster) => sum + cluster.trials, 0)).toBe(40);
    expect(clusters.map((cluster) => cluster.world)).toEqual([
      'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08',
      'C09', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15',
    ]);
  });

  it('nezávisí na pořadí vstupu — jinak by týž korpus dal jiný interval', () => {
    const forwards = outcomesFor(ids(), (id) => id.startsWith('C'));
    const backwards = [...forwards].reverse();

    expect(clustersOf(backwards).map((cluster) => cluster.world)).toEqual(
      clustersOf(forwards).map((cluster) => cluster.world),
    );
    expect(clusterBootstrap(clustersOf(backwards), { resamples: 2000 })).toEqual(
      clusterBootstrap(clustersOf(forwards), { resamples: 2000 }),
    );
  });

  it('přiřadí úpravu k jejímu základnímu světu, ne k sobě', () => {
    const clusters = clustersOf(outcomesFor(ids(), () => true));
    const byWorld = new Map(clusters.map((cluster) => [cluster.world, cluster]));

    // C01 má v korpusu čtyři úpravy, takže cluster je pětičlenný.
    expect(byWorld.get('C01')?.trials).toBe(5);
    expect(byWorld.get('C01')?.members.map((member) => member.id)).toContain('C01');
    expect(byWorld.get('C01')?.members.filter((member) => member.id.startsWith('E'))).toHaveLength(4);

    // C10 žádnou úpravu nemá — je to jednočlenný cluster, ne chybějící cluster.
    expect(byWorld.get('C10')?.trials).toBe(1);
  });

  it('počítá úspěchy uvnitř clusteru', () => {
    const clusters = clustersOf(outcomesFor(ids(), (id) => id === 'C01'));
    const first = clusters.find((cluster) => cluster.world === 'C01');
    expect(first?.successes).toBe(1);
    expect(first?.trials).toBe(5);
  });

  it('odmítne neznámé id i tentýž záznam dvakrát', () => {
    expect(() => clustersOf([{ id: 'Z99', success: true, record: null }])).toThrow(/není ve zmrazeném korpusu/);
    expect(() =>
      clustersOf([
        { id: 'C01', success: true, record: null },
        { id: 'C01', success: false, record: null },
      ]),
    ).toThrow(/dvakrát/);
  });
});

describe('minimum nezávislých světů', () => {
  it('celý korpus minimum drží', () => {
    const clusters = clustersOf(outcomesFor(ids(), () => true));
    expect(clusters.length).toBeGreaterThanOrEqual(PROTOCOL.minWorldClusters);
    expect(() => assertClusterFloor(clusters.length)).not.toThrow();
  });

  it('pod minimem report odmítne', () => {
    expect(() => assertClusterFloor(PROTOCOL.minWorldClusters - 1)).toThrow(ClusterFloorError);
    // Jedenáct create promptů = jedenáct clusterů, o jeden pod protokolem.
    const eleven = clustersOf(outcomesFor(ids('create').slice(0, 11), () => true));
    expect(eleven).toHaveLength(11);
    expect(() => assertClusterFloor(eleven.length)).toThrow(/11/);
  });

  it('dílčí míra nad editační větví minimum nedrží a přizná to', () => {
    const edits = clusteredRate(outcomesFor(ids('edit'), () => true), { resamples: 200 });
    expect(edits.clusters).toHaveLength(9);
    expect(edits.meetsClusterFloor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clusterovaná chyba
// ---------------------------------------------------------------------------

describe('clusterovaná chyba', () => {
  it('se u samých jednočlenných clusterů srovná s binomiální chybou', () => {
    const creates = ids('create');
    const outcomes = outcomesFor(creates, (id) => ['C01', 'C02', 'C03', 'C04'].includes(id));
    const clusters = clustersOf(outcomes);
    expect(clusters.every((cluster) => cluster.trials === 1)).toBe(true);

    const rate = 4 / creates.length;
    const expected = Math.sqrt((rate * (1 - rate)) / (creates.length - 1));
    near(clusterStandardError(clusters), expected, 1e-12);
  });

  it('roste, když jsou výsledky uvnitř světa svázané', () => {
    // Všechny úpravy jednoho světa dopadnou stejně — přesně ten případ, kvůli
    // kterému se clusteruje. Naivní binomiální chyba tady podstřelí.
    const edits = ids('edit');
    const winners = new Set(['C01', 'C02', 'C03', 'C04']);
    const outcomes = outcomesFor(edits, (id) => winners.has(CORPUS.get(id)?.world ?? ''));
    const clusters = clustersOf(outcomes);

    const trials = clusters.reduce((sum, cluster) => sum + cluster.trials, 0);
    const successes = clusters.reduce((sum, cluster) => sum + cluster.successes, 0);
    const rate = successes / trials;
    const naive = Math.sqrt((rate * (1 - rate)) / trials);

    expect(clusterStandardError(clusters)).toBeGreaterThan(naive);
  });

  it('nejde odhadnout z jednoho clusteru', () => {
    const single = clustersOf(outcomesFor(['C01'], () => true));
    expect(() => clusterStandardError(single)).toThrow(RangeError);
  });
});

describe('bootstrap přes clustery', () => {
  const mixed = (): readonly Cluster[] =>
    clustersOf(outcomesFor(ids(), (id) => ['C01', 'C02', 'C03', 'C04', 'C05', 'C06'].includes(CORPUS.get(id)?.world ?? '')));

  it('bere seed ze zmrazeného protokolu', () => {
    expect(clusterBootstrap(mixed()).seed).toBe(PROTOCOL.bootstrapSeed);
    expect(PROTOCOL.bootstrapSeed).toBe(20260812);
  });

  it('je na hodnotu reprodukovatelný', () => {
    const first = clusterBootstrap(mixed(), { resamples: 2000 });
    const second = clusterBootstrap(mixed(), { resamples: 2000 });
    expect(first).toEqual(second);
  });

  it('losuje doopravdy — interval není bod', () => {
    const interval = clusterBootstrap(mixed(), { resamples: 2000 });
    expect(interval.lower).toBeLessThan(interval.upper);
  });

  it('řeže percentily, nebere krajní hodnoty převzorkování', () => {
    // Užší hladina musí ležet ostře uvnitř širší. Kdyby se místo percentilu bralo
    // minimum a maximum, byly by všechny hladiny totožné.
    const options = { resamples: 4000 } as const;
    const half = clusterBootstrap(mixed(), { ...options, level: 0.5 });
    const usual = clusterBootstrap(mixed(), { ...options, level: 0.95 });
    const wide = clusterBootstrap(mixed(), { ...options, level: 0.999 });

    expect(half.lower).toBeGreaterThan(usual.lower);
    expect(half.upper).toBeLessThan(usual.upper);
    expect(usual.lower).toBeGreaterThan(wide.lower);
    expect(usual.upper).toBeLessThanOrEqual(wide.upper);
  });

  it('jiný seed dá jiný interval', () => {
    const options = { resamples: 4000 } as const;
    const fromProtocol = clusterBootstrap(mixed(), options);
    const other = clusterBootstrap(mixed(), { ...options, seed: 4242 });
    expect(other.seed).toBe(4242);
    expect([other.lower, other.upper]).not.toEqual([fromProtocol.lower, fromProtocol.upper]);
  });

  it('obklopuje bodový odhad a je širší než nezávislá mez', () => {
    const outcomes = outcomesFor(ids(), (id) => ['C01', 'C02', 'C03', 'C04', 'C05', 'C06'].includes(CORPUS.get(id)?.world ?? ''));
    const measured = clusteredRate(outcomes, { resamples: 4000 });
    expect(measured.interval.lower).toBeLessThanOrEqual(measured.rate);
    expect(measured.interval.upper).toBeGreaterThanOrEqual(measured.rate);

    const independent = wilsonInterval(measured.successes, measured.trials);
    const clusteredWidth = measured.interval.upper - measured.interval.lower;
    expect(clusteredWidth).toBeGreaterThan(independent.upper - independent.lower);
  });

  it('odmítne nesmyslné parametry', () => {
    expect(() => clusterBootstrap(mixed(), { resamples: 1 })).toThrow(RangeError);
    expect(() => clusterBootstrap(mixed(), { level: 1 })).toThrow(RangeError);
    expect(() => clusterBootstrap(clustersOf(outcomesFor(['C01'], () => true)))).toThrow(RangeError);
  });
});

describe('clusterovaná míra', () => {
  it('drží čitatele, jmenovatele i surové záznamy', () => {
    const outcomes = outcomesFor(ids(), (id) => id.startsWith('C'));
    const measured = clusteredRate(outcomes, { resamples: 500 });

    expect(measured.successes).toBe(15);
    expect(measured.trials).toBe(40);
    near(measured.rate, 15 / 40, 1e-12);
    expect(measured.meetsClusterFloor).toBe(true);

    const carried = measured.clusters.flatMap((cluster) => cluster.members);
    expect(carried).toHaveLength(40);
    expect(carried.find((member) => member.id === 'E01')?.record).toBe(
      outcomes.find((outcome) => outcome.id === 'E01')?.record,
    );
  });
});

// ---------------------------------------------------------------------------
// Třídní agregáty a podlahy
// ---------------------------------------------------------------------------

describe('třídní agregáty', () => {
  it('vykazují všech sedm tříd z protokolu i s jejich podlahou', () => {
    const aggregates = classAggregates(outcomesFor(ids(), () => true));
    expect(aggregates.map((aggregate) => aggregate.classId)).toEqual(PROTOCOL.classes.map((row) => row.id));
    for (const aggregate of aggregates) {
      const declared = PROTOCOL.classes.find((row) => row.id === aggregate.classId);
      expect(aggregate.floor).toBe(declared?.rawPassFloor);
      expect(aggregate.trials).toBe(declared?.count);
    }
    expect(aggregates.reduce((sum, aggregate) => sum + aggregate.trials, 0)).toBe(25);
  });

  it('drží odkaz na surové záznamy, ze kterých vznikly', () => {
    const outcomes = outcomesFor(ids('edit'), () => true);
    const aggregates = classAggregates(outcomes);
    const paramChange = aggregates.find((aggregate) => aggregate.classId === 'param_change');

    expect(paramChange?.members).toHaveLength(3);
    for (const member of paramChange?.members ?? []) {
      expect(CORPUS.get(member.id)?.editClass).toBe('param_change');
      expect(member.record).toBe(outcomes.find((outcome) => outcome.id === member.id)?.record);
    }
  });

  it('nezměřená třída nemá míru ani mez', () => {
    const aggregates = classAggregates(outcomesFor(ids('create'), () => true));
    for (const aggregate of aggregates) {
      expect(aggregate.trials).toBe(0);
      expect(aggregate.measured).toBe(false);
      expect(aggregate.rate).toBeNull();
      expect(aggregate.wilson).toBeNull();
      expect(aggregate.gated).toBe(false);
    }
    expect(() => assertClassFloors(aggregates)).not.toThrow();
  });

  it('v P1 podlahy VYKAZUJE, ale NEHRADÍ — jmenovatel je na to malý', () => {
    // Všechno propadne. Kdyby podlahy v P1 hradily, spadne to tady.
    const aggregates = classAggregates(outcomesFor(ids('edit'), () => false));
    expect(aggregates.every((aggregate) => aggregate.measured)).toBe(true);
    expect(aggregates.every((aggregate) => aggregate.rate === 0)).toBe(true);
    expect(aggregates.every((aggregate) => !aggregate.meetsFloor)).toBe(true);
    expect(aggregates.every((aggregate) => !aggregate.gated)).toBe(true);
    expect(aggregates.every((aggregate) => aggregate.trials < PROTOCOL.minDenominatorForFloor)).toBe(true);
    expect(() => assertClassFloors(aggregates)).not.toThrow();
  });
});

/**
 * Hradící větev podlahy se v P1 nespustí ani jednou — nejpočetnější třída má pět
 * záznamů, gating jmenovatel je dvanáct. Bez vlastní, dost velké třídy by tahle
 * cesta zůstala nedokázaná až do P7.
 */
describe('hradící podlaha nad dost velkým jmenovatelem', () => {
  const WIDE: StatsProtocol = {
    minWorldClusters: 12,
    minDenominatorForFloor: 12,
    bootstrapSeed: 1,
    classes: [
      { id: 'wide', count: 20, rawPassFloor: 0.9 },
      { id: 'narrow', count: 11, rawPassFloor: 0.9 },
    ],
  };

  const table = new Map<string, Classification>();
  for (let index = 1; index <= 20; index += 1)
    table.set(`X${index}`, { id: `X${index}`, branch: 'edit', world: 'W1', editClass: 'wide' });
  for (let index = 1; index <= 11; index += 1)
    table.set(`Y${index}`, { id: `Y${index}`, branch: 'edit', world: 'W2', editClass: 'narrow' });

  const wide = (successes: number): readonly Outcome[] =>
    [...Array(20).keys()].map((index) => ({ id: `X${index + 1}`, success: index < successes, record: index }));

  it('shodí běh, když měřitelná podlaha neprojde', () => {
    const aggregates = classAggregates(wide(15), WIDE, table);
    const measured = aggregates.find((aggregate) => aggregate.classId === 'wide');
    expect(measured?.gated).toBe(true);
    expect(measured?.rate).toBe(0.75);
    expect(measured?.meetsFloor).toBe(false);

    expect(() => assertClassFloors(aggregates)).toThrow(FloorViolationError);
    expect(() => assertClassFloors(aggregates)).toThrow(/wide 15\/20/);
  });

  it('projde, když ji splní', () => {
    const aggregates = classAggregates(wide(19), WIDE, table);
    expect(aggregates.find((aggregate) => aggregate.classId === 'wide')?.meetsFloor).toBe(true);
    expect(() => assertClassFloors(aggregates)).not.toThrow();
  });

  it('podlahu přesně na hranici bere jako splněnou', () => {
    const aggregates = classAggregates(wide(18), WIDE, table);
    expect(aggregates.find((aggregate) => aggregate.classId === 'wide')?.rate).toBe(0.9);
    expect(() => assertClassFloors(aggregates)).not.toThrow();
  });

  it('těsně pod gating jmenovatelem podlahu jen vykáže', () => {
    const outcomes = [...Array(11).keys()].map((index) => ({ id: `Y${index + 1}`, success: false, record: index }));
    const aggregates = classAggregates(outcomes, WIDE, table);
    const narrow = aggregates.find((aggregate) => aggregate.classId === 'narrow');

    expect(narrow?.trials).toBe(11);
    expect(narrow?.gated).toBe(false);
    expect(narrow?.meetsFloor).toBe(false);
    expect(() => assertClassFloors(aggregates)).not.toThrow();
  });
});
