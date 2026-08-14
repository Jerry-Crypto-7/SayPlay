/**
 * Clusterování podle identity světa a třídní agregáty (T20).
 *
 * ## Proč se vůbec clusteruje
 *
 * Čtyřicet záznamů korpusu **nejsou** čtyřicet nezávislých pokusů. Dvacet pět
 * editačních promptů visí na devíti základních světech, takže když je jeden svět
 * pro model snadný, jsou snadné i všechny jeho úpravy. Interval počítaný, jako by
 * šlo o nezávislé tahy, vyjde tím pádem užší, než jaká je skutečná nejistota —
 * a čím silnější je vazba uvnitř světa, tím větší je ten podvod na sobě samém.
 * Jednotkou vzorkování je proto svět, ne tah.
 *
 * ## Identitu světa určuje korpus, ne volající
 *
 * `Outcome` nese jen `id` a verdikt. Do kterého clusteru případ patří, se čte ze
 * zmrazených kontraktů (`create` sám sebe, `edit` svůj `baseWorld`). Kdyby si
 * cluster určoval volající, stačilo by špatné označení k tomu, aby se dva tahy
 * nad týmž světem počítaly jako dva nezávislé — přesně ta chyba, kterou má celá
 * tahle vrstva vyloučit.
 *
 * ## Dvě míry chyby, každá na něco jiného
 *
 * `clusterStandardError` je uzavřený tvar (linearizace poměrového odhadu),
 * `clusterBootstrap` je percentilový interval z převzorkování **clusterů**.
 * Bootstrap je to, na co míří seed ve zmrazeném protokolu; směrodatná chyba je
 * levná kontrola, že bootstrap neuletěl.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

import { nextInt } from '../../src/sim/rng';
import { wilsonInterval, type Interval } from './wilson';

const FROZEN_DIR = join(process.cwd(), 'evals', 'frozen');

// ---------------------------------------------------------------------------
// Zmrazený protokol
// ---------------------------------------------------------------------------

export interface EditClass {
  readonly id: string;
  /** Kolik záznamů té třídy korpus deklaruje. */
  readonly count: number;
  readonly rawPassFloor: number;
}

export interface StatsProtocol {
  readonly minWorldClusters: number;
  /**
   * Pod tímhle jmenovatelem se podlaha VYKAZUJE, ale NEHRADÍ.
   * `perClassFloorEnforcement` to říká rovnou: při jmenovateli 3–5 je podlaha
   * 0,93 neměřitelná (2/3 = 0,67, 3/3 = 1,00), takže by brána soudila šum.
   */
  readonly minDenominatorForFloor: number;
  readonly bootstrapSeed: number;
  readonly classes: readonly EditClass[];
}

interface ProtocolFile {
  readonly evalSet: {
    readonly minWorldClusters: number;
    readonly split: { readonly seed: number };
    readonly editClasses: readonly EditClass[];
    readonly perClassFloorEnforcement: { readonly minDenominatorForFloor: number };
  };
}

export function statsProtocol(): StatsProtocol {
  const protocol = JSON.parse(readFileSync(join(FROZEN_DIR, 'protocol.v1.json'), 'utf8')) as ProtocolFile;
  const set = protocol.evalSet;
  return {
    minWorldClusters: set.minWorldClusters,
    minDenominatorForFloor: set.perClassFloorEnforcement.minDenominatorForFloor,
    bootstrapSeed: set.split.seed,
    classes: set.editClasses.map(({ id, count, rawPassFloor }) => ({ id, count, rawPassFloor })),
  };
}

// ---------------------------------------------------------------------------
// Identita světa
// ---------------------------------------------------------------------------

export interface Classification {
  readonly id: string;
  readonly branch: 'create' | 'edit';
  /** Cluster případu: `create` je svým vlastním světem, `edit` patří pod svůj základ. */
  readonly world: string;
  readonly editClass: string | null;
}

interface ContractRow {
  readonly id: string;
  readonly kind: 'create' | 'edit';
  readonly baseWorld?: string;
  readonly editClass?: string;
}

export function frozenClassification(): ReadonlyMap<string, Classification> {
  const rows = readFileSync(join(FROZEN_DIR, 'contracts.v1.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ContractRow);

  const table = new Map<string, Classification>();
  for (const row of rows) {
    if (row.kind === 'edit' && row.baseWorld === undefined)
      throw new Error(`editační kontrakt ${row.id} nemá baseWorld — identitu světa nelze určit`);
    table.set(row.id, {
      id: row.id,
      branch: row.kind,
      world: row.kind === 'create' ? row.id : (row.baseWorld as string),
      editClass: row.editClass ?? null,
    });
  }
  return table;
}

// ---------------------------------------------------------------------------
// Vstup
// ---------------------------------------------------------------------------

export interface Outcome {
  /** Id ze zmrazeného korpusu. Neznámé id je chyba, ne vlastní cluster. */
  readonly id: string;
  readonly success: boolean;
  /** Surový záznam, ze kterého verdikt vznikl. Agregáty ho drží dál. */
  readonly record: unknown;
}

interface Resolved {
  readonly outcome: Outcome;
  readonly where: Classification;
}

/**
 * Přiřadí každému výsledku jeho místo v korpusu.
 *
 * Duplicitní `id` je odmítnutí, ne součet: tentýž tah započítaný dvakrát nafoukne
 * jmenovatel i cluster a udělá z jednoho pozorování dvě.
 */
function resolve(outcomes: readonly Outcome[], table: ReadonlyMap<string, Classification>): readonly Resolved[] {
  const seen = new Set<string>();
  return outcomes.map((outcome) => {
    if (seen.has(outcome.id)) throw new Error(`záznam ${outcome.id} je ve vstupu dvakrát`);
    seen.add(outcome.id);
    const where = table.get(outcome.id);
    if (where === undefined) throw new Error(`záznam ${outcome.id} není ve zmrazeném korpusu`);
    return { outcome, where };
  });
}

// ---------------------------------------------------------------------------
// Clustery
// ---------------------------------------------------------------------------

export interface Cluster {
  readonly world: string;
  readonly members: readonly Outcome[];
  readonly trials: number;
  readonly successes: number;
}

/**
 * Seskupí výsledky podle světa. Pořadí je podle jména světa, ne podle pořadí
 * vstupu — bootstrap losuje indexy do tohohle pole, takže by jiné pořadí vstupu
 * jinak vyrobilo jiný interval z týchž dat.
 */
export function clustersOf(
  outcomes: readonly Outcome[],
  table: ReadonlyMap<string, Classification> = frozenClassification(),
): readonly Cluster[] {
  const groups = new Map<string, Outcome[]>();
  for (const { outcome, where } of resolve(outcomes, table)) {
    const members = groups.get(where.world) ?? [];
    members.push(outcome);
    groups.set(where.world, members);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([world, members]) => ({
      world,
      members,
      trials: members.length,
      successes: members.filter((member) => member.success).length,
    }));
}

export class ClusterFloorError extends Error {
  constructor(
    readonly clusters: number,
    readonly minimum: number,
  ) {
    super(`nezávislých světových clusterů je ${clusters}, protokol žádá aspoň ${minimum}`);
    this.name = 'ClusterFloorError';
  }
}

/** Odmítnutí reportu pod minimem clusterů (`evalSet.minWorldClustersRule`). */
export function assertClusterFloor(clusters: number, protocol: StatsProtocol = statsProtocol()): void {
  if (clusters < protocol.minWorldClusters) throw new ClusterFloorError(clusters, protocol.minWorldClusters);
}

// ---------------------------------------------------------------------------
// Clusterovaná chyba
// ---------------------------------------------------------------------------

const totals = (clusters: readonly Cluster[]): { trials: number; successes: number } => ({
  trials: clusters.reduce((sum, cluster) => sum + cluster.trials, 0),
  successes: clusters.reduce((sum, cluster) => sum + cluster.successes, 0),
});

/**
 * Směrodatná chyba podílu, kde jednotkou vzorkování je cluster.
 *
 * Linearizace poměrového odhadu: √( m/(m−1) · Σ(sᶜ − p̂·nᶜ)² / N² ). Když má
 * každý cluster jediného člena, zbyde z toho p̂(1−p̂)/(m−1), tedy obyčejná
 * binomiální chyba — clusterování se v tom případě samo vypne, což je přesně to,
 * co má dělat.
 */
export function clusterStandardError(clusters: readonly Cluster[]): number {
  const count = clusters.length;
  if (count < 2) throw new RangeError(`chybu mezi clustery nelze odhadnout z ${count} clusterů`);
  const { trials, successes } = totals(clusters);
  if (trials === 0) throw new RangeError('clusterovaná chyba z prázdného jmenovatele');

  const rate = successes / trials;
  const scatter = clusters.reduce((sum, cluster) => {
    const residual = cluster.successes - rate * cluster.trials;
    return sum + residual * residual;
  }, 0);

  return Math.sqrt((count / (count - 1)) * (scatter / (trials * trials)));
}

export interface BootstrapInterval {
  readonly lower: number;
  readonly upper: number;
  readonly level: number;
  readonly seed: number;
  readonly resamples: number;
}

export interface BootstrapOptions {
  readonly seed?: number;
  readonly resamples?: number;
  readonly level?: number;
}

/**
 * Percentilový bootstrap přes **clustery**, ne přes tahy.
 *
 * Losuje se m clusterů s vracením a míra se pokaždé počítá jako poměr součtů,
 * takže nestejně velké světy nepřeváží jeden druhého. Stream je vlastní instance
 * `pure-rand` seedovaná ze zmrazeného protokolu — žádný jiný spotřebitel do něj
 * nesahá, takže je běh reprodukovatelný na hodnotu.
 */
export function clusterBootstrap(
  clusters: readonly Cluster[],
  options: BootstrapOptions = {},
  protocol: StatsProtocol = statsProtocol(),
): BootstrapInterval {
  const count = clusters.length;
  if (count < 2) throw new RangeError(`bootstrap přes clustery potřebuje aspoň dva, je jich ${count}`);

  const seed = options.seed ?? protocol.bootstrapSeed;
  const resamples = options.resamples ?? 10_000;
  const level = options.level ?? 0.95;
  if (!Number.isInteger(resamples) || resamples < 2) throw new RangeError(`resamples=${resamples} nedává interval`);
  if (!(level > 0 && level < 1)) throw new RangeError(`level=${level} není v (0, 1)`);

  const stream = xoroshiro128plus(seed);
  const rates = new Float64Array(resamples);

  for (let draw = 0; draw < resamples; draw += 1) {
    let trials = 0;
    let successes = 0;
    for (let pick = 0; pick < count; pick += 1) {
      const cluster = clusters[nextInt(stream, 0, count - 1)];
      trials += cluster.trials;
      successes += cluster.successes;
    }
    rates[draw] = successes / trials;
  }

  const sorted = rates.sort();
  const alpha = 1 - level;
  const at = (index: number): number => sorted[Math.min(Math.max(index, 0), resamples - 1)];

  return {
    lower: at(Math.floor((alpha / 2) * resamples)),
    upper: at(Math.ceil((1 - alpha / 2) * resamples) - 1),
    level,
    seed,
    resamples,
  };
}

export interface ClusteredRate {
  readonly rate: number;
  readonly successes: number;
  readonly trials: number;
  readonly clusters: readonly Cluster[];
  readonly standardError: number;
  readonly interval: BootstrapInterval;
  /**
   * Drží report minimum nezávislých světů? Rozhoduje se o tom na úrovni reportu
   * (`assertClusterFloor`), ne tady — dílčí míra nad jednou větví korpusu má
   * clusterů z podstaty míň, než kolik protokol žádá po celku.
   */
  readonly meetsClusterFloor: boolean;
}

export function clusteredRate(
  outcomes: readonly Outcome[],
  options: BootstrapOptions = {},
  protocol: StatsProtocol = statsProtocol(),
): ClusteredRate {
  const clusters = clustersOf(outcomes);
  const { trials, successes } = totals(clusters);
  if (trials === 0) throw new RangeError('clusterovaná míra z prázdného jmenovatele');

  return {
    rate: successes / trials,
    successes,
    trials,
    clusters,
    standardError: clusterStandardError(clusters),
    interval: clusterBootstrap(clusters, options, protocol),
    meetsClusterFloor: clusters.length >= protocol.minWorldClusters,
  };
}

// ---------------------------------------------------------------------------
// Třídní agregáty a podlahy
// ---------------------------------------------------------------------------

export interface ClassAggregate {
  readonly classId: string;
  readonly floor: number;
  readonly successes: number;
  readonly trials: number;
  /** `null` u nezměřené třídy — nula z nuly není nula procent. */
  readonly rate: number | null;
  readonly wilson: Interval | null;
  readonly measured: boolean;
  /** Je jmenovatel dost velký, aby podlaha hradila? Jinak se jen vykazuje. */
  readonly gated: boolean;
  readonly meetsFloor: boolean;
  /** Odkaz na surové záznamy, ze kterých agregát vznikl. */
  readonly members: readonly Outcome[];
}

/**
 * Agregát na každou třídu úpravy z protokolu — i na tu, ke které nepřišel jediný
 * záznam. Chybějící třída by se v reportu neprojevila vůbec, a nezměřená podlaha
 * musí být vidět.
 *
 * `create` záznamy do žádné třídy nepatří; třídy popisují jen úpravy.
 */
export function classAggregates(
  outcomes: readonly Outcome[],
  protocol: StatsProtocol = statsProtocol(),
  table: ReadonlyMap<string, Classification> = frozenClassification(),
): readonly ClassAggregate[] {
  const byClass = new Map<string, Outcome[]>();
  for (const { outcome, where } of resolve(outcomes, table)) {
    if (where.editClass === null) continue;
    const members = byClass.get(where.editClass) ?? [];
    members.push(outcome);
    byClass.set(where.editClass, members);
  }

  return protocol.classes.map((editClass) => {
    const members = byClass.get(editClass.id) ?? [];
    const trials = members.length;
    const successes = members.filter((member) => member.success).length;
    const rate = trials === 0 ? null : successes / trials;
    return {
      classId: editClass.id,
      floor: editClass.rawPassFloor,
      successes,
      trials,
      rate,
      wilson: trials === 0 ? null : wilsonInterval(successes, trials),
      measured: trials > 0,
      gated: trials >= protocol.minDenominatorForFloor,
      meetsFloor: rate !== null && rate >= editClass.rawPassFloor,
      members,
    };
  });
}

export class FloorViolationError extends Error {
  constructor(readonly violations: readonly ClassAggregate[]) {
    super(
      `podlaha neprošla u ${violations.length} tříd: ${violations
        .map((violation) => `${violation.classId} ${violation.successes}/${violation.trials} < ${violation.floor}`)
        .join(', ')}`,
    );
    this.name = 'FloorViolationError';
  }
}

/**
 * Shodí běh na porušené třídní podlaze — ale jen u tříd, kde je podlaha vůbec
 * měřitelná (`gated`). V P1 má nejpočetnější třída pět záznamů, takže tahle
 * cesta tady zatím nehradí nic a spustí ji až rozšíření sady v P7. Proto ji
 * jednotkový test volá s vlastní, dost velkou třídou — jinak by se nikdy
 * neprovedla.
 */
export function assertClassFloors(aggregates: readonly ClassAggregate[]): void {
  const violations = aggregates.filter((aggregate) => aggregate.gated && !aggregate.meetsFloor);
  if (violations.length > 0) throw new FloorViolationError(violations);
}
