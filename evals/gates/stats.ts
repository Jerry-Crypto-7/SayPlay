/**
 * Statistická vrstva nad kill gate (T706).
 *
 * ## Nic tady nevzniká, všechno se ověřuje
 *
 * Clusterovaný interval **je vstup, ne nová veličina**. Naměřil ho P1 T21 a leží
 * v `evals/kill-gate-report.json`; tahle vrstva ho přebírá tak, jak je, a jen
 * ověří, že se dá zopakovat bootstrapem z `evals/harness/cluster.ts` nad **toutéž
 * tabulkou clusterů** a se **seedem ze zmrazeného protokolu**. Kdyby se
 * počítal znovu s vlastními parametry, byla by to druhá hodnota téhož jména – a
 * ta se s první rozejde přesně ve chvíli, kdy na tom začne záležet.
 *
 * Seed se bere z protokolu, ne z reportu. To je celý zámek: kdo by chtěl interval
 * podvrhnout, musel by sáhnout do zmrazeného souboru, ne do reportu, který sám
 * píše. `reproduced: false` shodí `publishable`, takže se rozpor nedá přejít.
 *
 * ## Neúplný běh nemá míru úspěšnosti, ne „opatrnou" míru
 *
 * `evalSet.incompleteRunRule` říká doslova, že *„žádná míra úspěšnosti se
 * nepočítá z neúplného jmenovatele"*. Vrstva to bere vážně: při `complete:
 * false` je `rate`, `wilson` i `meetsFloor` **`null`** a status `INCOMPLETE`.
 * Zlomek `successes/trials` zůstává vidět, protože to jsou naměřená data –
 * podíl z nich už by ale bylo tvrzení, které se nezměřilo.
 *
 * ## Podlahy po třídách se vykazují zvlášť a řídí je protokol
 *
 * Třídy i jejich podlahy se čtou ze zmrazeného protokolu, ne ze serializovaného
 * reportu. Chybějící třída je odmítnutí: ztratit řádek je tichý způsob, jak
 * podlahu obejít. Třída navíc je odmítnutí ze stejného důvodu obráceně.
 * `enforced` je vlastní pole – podlaha 0,93 na jmenovateli 3 se **vykazuje**,
 * ale nehradí, a splést tyhle dva stavy je přesně to změkčení, které
 * `perClassFloorEnforcement` zakazuje.
 */

import {
  clusterBootstrap,
  statsProtocol,
  type BootstrapInterval,
  type Cluster,
  type StatsProtocol,
} from '../harness/cluster';
import type { KillGateReport, RateBlock } from '../harness/kill-gate';
import { wilsonInterval, type Interval } from '../harness/wilson';

export const CLUSTER_SOURCE = 'evals/kill-gate-report.json → clustered';

const INCOMPLETE_NOTE = 'neúplný běh – míra se z neúplného jmenovatele nepočítá (evalSet.incompleteRunRule)';

const MEASURED_NOTE = 'bod, Wilsonova mez a shlukování se vykazují spolu; holé procento nikdy samo';

/** `INCOMPLETE` není opatrnější `MEASURED`, je to nepřítomnost míry. */
export type RateStatus = 'MEASURED' | 'INCOMPLETE';

export interface RateSummary {
  readonly id: string;
  readonly successes: number;
  readonly trials: number;
  /** `null` u neúplného běhu i u prázdného jmenovatele. */
  readonly rate: number | null;
  readonly wilson: Interval | null;
  readonly floor: number | null;
  readonly meetsFloor: boolean | null;
  readonly status: RateStatus;
  /** `false` kdykoli běh není citovatelný – razítkem nebo neúplností. */
  readonly claimable: boolean;
  readonly note: string;
}

export interface ClassFloorRow {
  readonly classId: string;
  readonly successes: number;
  readonly trials: number;
  readonly rate: number | null;
  readonly wilson: Interval | null;
  readonly floor: number;
  readonly minDenominator: number;
  /** Hradí podlaha? Jinak se jen vykazuje. */
  readonly enforced: boolean;
  readonly meetsFloor: boolean | null;
  readonly status: RateStatus;
}

export interface ClusteredInput {
  readonly rate: number;
  readonly clusters: number;
  readonly minWorldClusters: number;
  readonly meetsClusterFloor: boolean;
  /** Interval z reportu. Tohle je ta hodnota, která se vykazuje. */
  readonly interval: BootstrapInterval;
  readonly source: string;
  /** Doslovná konstanta: vrstva interval nerazí, jen přebírá. */
  readonly mintedHere: false;
  readonly reproduced: boolean;
  /** Kontrolní přepočet ze zmrazeného seedu. Vykazuje se vedle, ne místo. */
  readonly reproducedInterval: BootstrapInterval;
}

export interface GateStatistics {
  readonly schema: 'gate-statistics.v1';
  readonly complete: boolean;
  readonly completedCases: number;
  readonly plannedCases: number;
  readonly incompleteReason: string | null;
  readonly publishable: boolean;
  /** Prázdné právě tehdy, když je `publishable`. Nikdy jen „ne". */
  readonly publishableReasons: readonly string[];
  readonly clustered: ClusteredInput;
  readonly rates: readonly RateSummary[];
  readonly classFloors: readonly ClassFloorRow[];
  readonly enforcedClassFloors: number;
}

// ---------------------------------------------------------------------------
// Agregátní míry
// ---------------------------------------------------------------------------

function summarise(block: RateBlock, complete: boolean, incompleteReason: string | null): RateSummary {
  if (!complete)
    return {
      id: block.id,
      successes: block.successes,
      trials: block.trials,
      rate: null,
      wilson: null,
      floor: block.floor,
      meetsFloor: null,
      status: 'INCOMPLETE',
      claimable: false,
      note: incompleteReason === null ? INCOMPLETE_NOTE : `${INCOMPLETE_NOTE}: ${incompleteReason}`,
    };

  const rate = block.trials === 0 ? null : block.successes / block.trials;
  return {
    id: block.id,
    successes: block.successes,
    trials: block.trials,
    rate,
    wilson: block.trials === 0 ? null : wilsonInterval(block.successes, block.trials),
    floor: block.floor,
    meetsFloor: rate === null || block.floor === null ? null : rate >= block.floor,
    status: 'MEASURED',
    claimable: block.claimable,
    note: MEASURED_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Podlahy po třídách
// ---------------------------------------------------------------------------

function classFloorRows(report: KillGateReport, protocol: StatsProtocol): readonly ClassFloorRow[] {
  const measured = new Map(report.perClassFloors.map((aggregate) => [aggregate.classId, aggregate]));
  const known = new Set(protocol.classes.map((editClass) => editClass.id));

  for (const aggregate of report.perClassFloors)
    if (!known.has(aggregate.classId))
      throw new Error(`report vykazuje třídu ${aggregate.classId}, kterou zmrazený protokol nezná`);

  return protocol.classes.map((editClass) => {
    const found = measured.get(editClass.id);
    if (found === undefined)
      throw new Error(`report neuvádí třídu ${editClass.id} – chybějící řádek je tichý způsob, jak podlahu obejít`);

    const rate = !report.complete || found.trials === 0 ? null : found.successes / found.trials;
    return {
      classId: editClass.id,
      successes: found.successes,
      trials: found.trials,
      rate,
      wilson: rate === null ? null : wilsonInterval(found.successes, found.trials),
      floor: editClass.rawPassFloor,
      minDenominator: protocol.minDenominatorForFloor,
      enforced: report.complete && found.trials >= protocol.minDenominatorForFloor,
      meetsFloor: rate === null ? null : rate >= editClass.rawPassFloor,
      status: report.complete ? 'MEASURED' : 'INCOMPLETE',
    };
  });
}

// ---------------------------------------------------------------------------
// Clusterovaný interval
// ---------------------------------------------------------------------------

function clusteredInput(report: KillGateReport, protocol: StatsProtocol): ClusteredInput {
  const reported = report.clustered.interval;

  // `members` bootstrap nečte – losuje clustery a sčítá `trials` a `successes`.
  // Pořadí je pořadí z reportu, tedy totéž, ve kterém interval vznikl; jiné
  // pořadí by z týchž dat vyrobilo jiné losy a přepočet by neseděl bez viny.
  const clusters: readonly Cluster[] = report.clustered.clusters.map((entry) => ({
    world: entry.world,
    members: [],
    trials: entry.trials,
    successes: entry.successes,
  }));

  const reproducedInterval = clusterBootstrap(
    clusters,
    { seed: protocol.bootstrapSeed, resamples: reported.resamples, level: reported.level },
    protocol,
  );

  return {
    rate: report.clustered.rate,
    clusters: report.corpus.clusters,
    minWorldClusters: protocol.minWorldClusters,
    meetsClusterFloor: report.corpus.clusters >= protocol.minWorldClusters,
    interval: reported,
    source: CLUSTER_SOURCE,
    mintedHere: false,
    reproduced:
      reported.seed === protocol.bootstrapSeed &&
      reproducedInterval.lower === reported.lower &&
      reproducedInterval.upper === reported.upper,
    reproducedInterval,
  };
}

// ---------------------------------------------------------------------------
// Celek
// ---------------------------------------------------------------------------

export function gateStatistics(report: KillGateReport, protocol: StatsProtocol = statsProtocol()): GateStatistics {
  const clustered = clusteredInput(report, protocol);
  const classFloors = classFloorRows(report, protocol);
  const rates = [report.fulfilledRate, report.rawPatchPassRate, report.firstRequestCommitRate].map((block) =>
    summarise(block, report.complete, report.incompleteReason),
  );

  const reasons: string[] = [];
  if (!report.complete)
    reasons.push(
      `běh je neúplný: ${report.incompleteReason ?? `odbaveno ${report.completedCases} z ${report.plannedCases}`}`,
    );
  if (!report.gate.headlineClaimable) reasons.push(`razítko běhu je ${report.gate.grade} – ${report.gate.reason}`);
  if (!clustered.reproduced)
    reasons.push('clusterovaný interval se nereprodukuje bootstrapem ze zmrazeného seedu');
  if (!clustered.meetsClusterFloor)
    reasons.push(`clusterů je ${clustered.clusters}, protokol žádá aspoň ${clustered.minWorldClusters}`);

  return {
    schema: 'gate-statistics.v1',
    complete: report.complete,
    completedCases: report.completedCases,
    plannedCases: report.plannedCases,
    incompleteReason: report.incompleteReason,
    publishable: reasons.length === 0,
    publishableReasons: reasons,
    clustered,
    rates,
    classFloors,
    enforcedClassFloors: classFloors.filter((row) => row.enforced).length,
  };
}
