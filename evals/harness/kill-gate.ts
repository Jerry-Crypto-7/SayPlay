/**
 * Kill gate report (T21) — jediný zapisovatel `evals/kill-gate-report.json`.
 *
 * Vezme naměřené výsledky **obou** živých větví — tvorby (T18, `runLiveChain`) a
 * tříúpravové relace (T19, `runEditSessions`) — a složí z nich artefakt, podle
 * kterého se rozhoduje HALT brána za touhle úlohou.
 *
 * ## Čitatelem je `FULFILLED`, ne validita a ne commitovatelnost
 *
 * AC úlohy to říká tvrdě a je to celá oprava nálezu review v2: report mohl být
 * auditovatelný, statisticky správný — a přitom měřit jen to, že se emise dala
 * naparsovat. Každá `RateBlock` níž proto nese `numerator: 'FULFILLED'` jako
 * doslovnou konstantu a její čitatel se počítá **výhradně** ze sémantického
 * verdiktu T16. Rozdíly mezi mírami jsou v tom, **kolik práce** systém do
 * výsledku investoval (žádná oprava / nejvýš jedna), nikdy v tom, co se za
 * úspěch prohlásí.
 *
 * Jediné dvě čísla, která `FULFILLED` v čitateli nemají, ho mít nesmějí a
 * říkají to o sobě sama: `structuralContract` je **invariant potrubí** (žádný
 * přijatý kandidát nesmí být necertifikovaný), ne míra kvality modelu, a
 * `commitsWithoutSecondCall` je podíl nad commity. Vydávat je za míru úspěšnosti
 * by tu větu z AC obešlo přesně tam, kde na ní záleží.
 *
 * ## Profil jde do artefaktu nahlas, místo aby artefakt nevznikl
 *
 * `reportPath` v `./live` pustí `LiveReport` pod vyhrazené jméno jedině z profilu
 * `api`. Brána vznikla správně — proti tomu, aby se levné vývojové číslo tiše
 * stalo headline číslem. Jenže `OPENAI_API_KEY` na tomhle stroji není a
 * **uživatel dvakrát výslovně rozhodl, že se vkládat nebude** (T18), takže by
 * oficiální artefakt nevznikl nikdy a HALT brána by neměla podle čeho
 * rozhodnout. Doporučení zapsané u T18 zní: *„bránu rozšířit tak, aby profil šel
 * nahlas do artefaktu i do každého tvrzení nad ním, místo aby report nevznikl.
 * Obava, kvůli které brána je, míří na tiché propašování, ne na tu cestu samu."*
 *
 * Tenhle soubor to dělá takhle: report se zapíše vždycky, `gate` je **první klíč**
 * souboru, a **každá jednotlivá míra** nese `claimable`. Vývojové číslo se tedy
 * nedá odcitovat, aniž by si ten, kdo cituje, přečetl, co drží v ruce.
 *
 * ## Grade rozhoduje disk, ne proměnná
 *
 * `standing` se počítá ze **souborů v `evals/live/<runId>/responses/`**, ne z
 * hlavičky reportu. Nález u T18 to žádá doslova a je to jediná verze té kontroly,
 * která něco dokazuje: hlavičku i případy plní tentýž `preflight`, takže si je
 * skládá ten, kdo report vykazuje. Razítko na disku vzniklo ve chvíli volání.
 *
 * ## Neúplný běh se nevykazuje jako výsledek
 *
 * `evalSet.incompleteRunRule` zmrazeného protokolu: *„žádná míra úspěšnosti se
 * nepočítá z neúplného jmenovatele"*. Report proto nese `completedCases` a
 * `plannedCases`, a když se nerovnají, je `complete: false` s uvedeným důvodem
 * zastavení. Zapsat se smí — publikovat jako výsledek brány ne.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertClusterFloor,
  classAggregates,
  clusteredRate,
  statsProtocol,
  type ClassAggregate,
  type ClusteredRate,
  type Outcome,
  type StatsProtocol,
} from './cluster';
import { KILL_GATE_REPORT, gateStanding, storedProfiles, type GateStanding, type LiveCaseResult, type LiveReport } from './live';
import { TURNS_PER_SESSION, type FrozenBodyMatch, type SessionReport, type SessionTurn } from './session';
import { wilsonInterval, type Interval } from './wilson';

// ---------------------------------------------------------------------------
// Prahy ze zmrazeného protokolu
// ---------------------------------------------------------------------------

interface AggregateGateFile {
  /** `aggregateGates` leží pod `evalSet`, ne v kořeni — viz `protocol.v1.json`. */
  readonly evalSet: {
    readonly aggregateGates: {
      readonly rawPatchPassRate: { readonly floor: number };
      readonly firstRequestCommitRate: { readonly floor: number };
      readonly structuralContract: { readonly floor: number };
      readonly wilsonCaveat: string;
    };
  };
}

/**
 * Prahy se čtou ze zmrazeného protokolu, nikdy se sem neopisují.
 *
 * Opsaná konstanta je druhý zdroj pravdy o tom, co je úspěch — a ten se s
 * korpusem rozejde přesně ve chvíli, kdy na tom začne záležet.
 */
export function aggregateGates(): AggregateGateFile['evalSet']['aggregateGates'] {
  // Táž cesta a týž způsob čtení jako `statsProtocol()` v `cluster.ts`, který ze
  // stejného souboru bere jiné klíče. Kořen je `process.cwd()`, ne `import.meta`:
  // řetěz běží i pod Playwrightem, kde je `import.meta` syntaktická chyba.
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'evals', 'frozen', 'protocol.v1.json'), 'utf8'),
  ) as AggregateGateFile;
  return raw.evalSet.aggregateGates;
}

// ---------------------------------------------------------------------------
// Jedna míra úspěšnosti
// ---------------------------------------------------------------------------

export interface RateBlock {
  readonly id: string;
  /**
   * Doslovná konstanta, ne dopočet — strojově čitelná podoba té věty z AC, kterou
   * má report splnit. Typ je literál, takže míru s jiným čitatelem odmítne
   * překladač; `rateBlock` je jediná cesta, jak `RateBlock` vzniká.
   */
  readonly numerator: 'FULFILLED';
  readonly definition: string;
  readonly successes: number;
  readonly trials: number;
  /** `null` u prázdného jmenovatele — nula z nuly není nula procent. */
  readonly rate: number | null;
  readonly wilson: Interval | null;
  readonly floor: number | null;
  readonly meetsFloor: boolean | null;
  /** `false` kdykoli `gate.grade !== 'GATE'`. Cituje se to spolu s číslem. */
  readonly claimable: boolean;
  /** Id záznamů, ze kterých čitatel vznikl. Agregát drží odkaz na surová data. */
  readonly successIds: readonly string[];
}

function rateBlock(
  id: string,
  definition: string,
  outcomes: readonly Outcome[],
  floor: number | null,
  claimable: boolean,
): RateBlock {
  const successes = outcomes.filter((outcome) => outcome.success);
  const trials = outcomes.length;
  const rate = trials === 0 ? null : successes.length / trials;
  return {
    id,
    numerator: 'FULFILLED',
    definition,
    successes: successes.length,
    trials,
    rate,
    wilson: trials === 0 ? null : wilsonInterval(successes.length, trials),
    floor,
    meetsFloor: rate === null || floor === null ? null : rate >= floor,
    claimable,
    successIds: successes.map((outcome) => outcome.id),
  };
}

// ---------------------------------------------------------------------------
// Případ obou větví v jednom tvaru
// ---------------------------------------------------------------------------

/**
 * Co z případu report potřebuje — a **jen** to.
 *
 * Obě větve mají vlastní bohatý tvar (`LiveCaseResult`, `SessionTurn`) a jsou
 * záměrně nesouměřitelné: tvorba nemá `changedLeaves`, editace nemá `parsedVia`
 * emise světa. Sjednotit je až tady, na pěti polích, znamená, že se míra počítá
 * z jedné definice úspěchu pro obě větve — a že se nedá omylem započítat tvorba
 * jinou stupnicí než úprava.
 */
interface Candidate {
  readonly id: string;
  readonly branch: 'create' | 'edit';
  readonly fulfilled: boolean;
  /** Kolik oprav systém spotřeboval, než výsledek přijal. V P1 nejvýš jedna. */
  readonly repairs: number;
  /** Přijal systém toho kandidáta? Tvorba: certifikovaný svět. Editace: `sim` se aplikovala. */
  readonly accepted: boolean;
  /** Strukturální selhání potrubí u tohohle případu (řetěz, stadia, prohlížeč). */
  readonly structuralFailures: readonly string[];
  /** Kudy se dá zpětně doložit — cesta k uložené odpovědi a její hash. */
  readonly responsePath: string;
  readonly rawHash: string;
}

const STRUCTURAL_KINDS: ReadonlySet<string> = new Set([
  'chain-broken',
  'stage-missing',
  'first-hash',
  'browser-divergence',
  'pipeline-disagreement',
  'frozen-leak',
]);

/**
 * Tvorba: **přijatý kandidát je certifikovaný svět**, ne zapečetěný dokument.
 *
 * `offlineHash` je neprázdný právě tehdy, když se svět postavil a jeho svědek
 * došel do výhry — tedy přesně za podmínky, za jaké `POST /api/emit` vrací
 * `CERTIFIED`. `stoppedAt === null` by tu nestačilo: to je `null` i u poctivého
 * `NO_FIT`, kde žádný svět nevznikl.
 */
function fromCreate(result: LiveCaseResult): Candidate {
  return {
    id: result.id,
    branch: 'create',
    fulfilled: result.verdict === 'FULFILLED',
    repairs: result.repairApplied.length === 0 ? 0 : 1,
    accepted: result.offlineHash !== null,
    structuralFailures: result.failures.filter((failure) => STRUCTURAL_KINDS.has(failure.kind)).map((failure) => `${failure.kind}: ${failure.detail}`),
    responsePath: result.responsePath,
    rawHash: result.rawHash,
  };
}

/** Editace: oprava je definovaná nad emisí světa, ne nad patchem — tedy nikdy. */
function fromTurn(turn: SessionTurn): Candidate {
  return {
    id: turn.promptId,
    branch: 'edit',
    fulfilled: turn.verdict === 'FULFILLED',
    repairs: 0,
    accepted: turn.committed,
    structuralFailures: turn.failures.filter((failure) => STRUCTURAL_KINDS.has(failure.kind)).map((failure) => `${failure.kind}: ${failure.detail}`),
    responsePath: turn.responsePath,
    rawHash: turn.rawHash,
  };
}

const asOutcome = (candidate: Candidate, success: boolean): Outcome => ({
  id: candidate.id,
  success,
  record: {
    branch: candidate.branch,
    fulfilled: candidate.fulfilled,
    repairs: candidate.repairs,
    accepted: candidate.accepted,
    responsePath: candidate.responsePath,
    rawHash: candidate.rawHash,
  },
});

// ---------------------------------------------------------------------------
// Ostatní bloky reportu
// ---------------------------------------------------------------------------

export interface StructuralContract {
  readonly floor: number;
  readonly accepted: number;
  readonly clean: number;
  readonly rate: number | null;
  readonly meetsFloor: boolean | null;
  /** Proč tenhle blok NEmá `FULFILLED` v čitateli. Viz hlavička souboru. */
  readonly notARate: string;
  readonly violations: readonly { readonly id: string; readonly detail: string }[];
}

export interface TimeToCommit {
  /** Jednotka. **Volání poskytovatele**, ne vteřiny — viz `honestNote`. */
  readonly unit: 'providerRequests';
  readonly committedOnRawEmission: number;
  readonly committedAfterOneRepair: number;
  readonly neverCommitted: number;
  readonly maxRequestsUsed: number;
  readonly honestNote: string;
  readonly byCase: readonly { readonly id: string; readonly requests: number | null }[];
}

export interface CommitsWithoutSecondCall {
  readonly commits: number;
  readonly withoutSecondCall: number;
  readonly share: number | null;
  /** `true` = číslo je vlastnost potrubí, ne naměřený úspěch modelu. */
  readonly structural: boolean;
  readonly honestNote: string;
}

export interface ThreeEditSession {
  readonly measuredDirectly: true;
  readonly sessionsPassed: number;
  readonly sessionsCompleted: number;
  readonly sessionsPlanned: number;
  readonly rate: number | null;
  readonly turnsPassed: number;
  readonly turnsRun: number;
  readonly turnRate: number | null;
  /** `turnRate³` — zakázaný dopočet, vykázaný **vedle** naměřené hodnoty. */
  readonly independenceEstimate: number | null;
  readonly contrastNote: string;
}

export interface KillGateReport {
  readonly schema: 'kill-gate-report.v1';
  /** **První klíč souboru.** Nikdo nemá jak číst čísla dřív než tenhle blok. */
  readonly gate: GateStanding;
  readonly complete: boolean;
  readonly completedCases: number;
  readonly plannedCases: number;
  readonly incompleteReason: string | null;
  readonly run: {
    readonly createRunId: string;
    readonly editRunId: string;
    readonly model: string;
    readonly responseDirs: readonly string[];
  };
  readonly corpus: {
    readonly clusters: number;
    readonly minWorldClusters: number;
    readonly worlds: readonly { readonly world: string; readonly trials: number; readonly successes: number }[];
  };
  readonly fulfilledRate: RateBlock;
  readonly rawPatchPassRate: RateBlock;
  readonly firstRequestCommitRate: RateBlock;
  readonly structuralContract: StructuralContract;
  readonly perClassFloors: readonly ClassAggregate[];
  readonly clustered: Omit<ClusteredRate, 'clusters'> & {
    readonly clusters: readonly { readonly world: string; readonly trials: number; readonly successes: number }[];
  };
  readonly wilsonCaveat: string;
  readonly timeToCommit: TimeToCommit;
  readonly commitsWithoutSecondCall: CommitsWithoutSecondCall;
  readonly threeEditSession: ThreeEditSession;
  readonly findings: {
    readonly frozenBodyMatches: readonly FrozenBodyMatch[];
    readonly harnessFailures: readonly { readonly caseId: string; readonly kind: string; readonly detail: string }[];
  };
  readonly cases: readonly Candidate[];
}

export interface KillGateInput {
  readonly create: LiveReport;
  readonly edit: SessionReport;
}

// ---------------------------------------------------------------------------
// Složení reportu
// ---------------------------------------------------------------------------

/**
 * Složí report z obou živých větví.
 *
 * **Odmítne ho**, když počet nezávislých světových clusterů klesne pod minimum
 * zmrazeného protokolu (`ClusterFloorError` z `assertClusterFloor`). Je to
 * jediná tvrdá podmínka existence artefaktu, protože všechno ostatní se dá
 * poctivě vykázat i špatné — kdežto interval spočítaný z pěti světů vypadá
 * úplně stejně jako z patnácti a mlčky tvrdí něco, co nezměřil.
 */
export function killGateReport(input: KillGateInput, protocol: StatsProtocol = statsProtocol()): KillGateReport {
  const gates = aggregateGates();

  // Grade rozhoduje **disk**, ne hlavička reportu. Viz hlavička souboru.
  const responseDirs = [input.create.responsesDir, input.edit.responsesDir];
  const standing = gateStanding(storedProfiles(responseDirs));
  const claimable = standing.headlineClaimable;

  const candidates: readonly Candidate[] = [
    ...input.create.cases.map(fromCreate),
    ...input.edit.sessions.flatMap((session) => session.turns.map(fromTurn)),
  ];
  // Prázdný vstup se odmítá **tady**, s vlastní větou. Níž by na něm spadl
  // `clusteredRate` hláškou o prázdném jmenovateli, což je pravda o statistice a
  // ne o tom, co se doopravdy stalo: neproběhl ani jeden živý případ.
  if (candidates.length === 0)
    throw new Error('kill gate report nemá z čeho vzniknout: ani tvorba, ani editace neodbavily jediný případ');

  const all = candidates.map((candidate) => asOutcome(candidate, candidate.fulfilled));
  const clustered = clusteredRate(all, {}, protocol);
  // Musí padnout DŘÍV, než z toho vznikne soubor. Report pod minimem clusterů
  // se nezapisuje vůbec — přiznaná slabina je pořád artefakt, který někdo cituje.
  assertClusterFloor(clustered.clusters.length, protocol);

  const editOutcomes = candidates.filter((candidate) => candidate.branch === 'edit').map((candidate) => asOutcome(candidate, candidate.fulfilled));

  const accepted = candidates.filter((candidate) => candidate.accepted);
  const violations = accepted
    .filter((candidate) => candidate.structuralFailures.length > 0)
    .map((candidate) => ({ id: candidate.id, detail: candidate.structuralFailures.join('; ') }));

  const plannedCases = input.create.total + input.edit.sessionsPlanned * TURNS_PER_SESSION;
  const completedCases = candidates.length;
  const incompleteReason =
    input.create.stoppedReason ?? input.edit.stoppedReason ?? (completedCases === plannedCases ? null : `odbaveno ${completedCases} z ${plannedCases} případů`);

  const commits = accepted.length;

  return {
    schema: 'kill-gate-report.v1',
    gate: standing,
    complete: input.create.complete && input.edit.complete && completedCases === plannedCases,
    completedCases,
    plannedCases,
    incompleteReason,
    run: {
      createRunId: input.create.runId,
      editRunId: input.edit.runId,
      model: input.create.model,
      responseDirs,
    },
    corpus: {
      clusters: clustered.clusters.length,
      minWorldClusters: protocol.minWorldClusters,
      worlds: clustered.clusters.map(({ world, trials, successes }) => ({ world, trials, successes })),
    },

    fulfilledRate: rateBlock(
      'fulfilledRate',
      'podíl případů obou větví se sémantickým verdiktem FULFILLED z T16',
      all,
      null,
      claimable,
    ),
    rawPatchPassRate: rateBlock(
      'rawPatchPassRate',
      'FULFILLED bez jediné mechanické opravy — syrová první emise modelu',
      candidates.map((candidate) => asOutcome(candidate, candidate.fulfilled && candidate.repairs === 0)),
      gates.rawPatchPassRate.floor,
      claimable,
    ),
    firstRequestCommitRate: rateBlock(
      'firstRequestCommitRate',
      'FULFILLED po nejvýš jedné automatické opravě, tedy uvnitř téhož uživatelského požadavku',
      candidates.map((candidate) => asOutcome(candidate, candidate.fulfilled && candidate.repairs <= 1)),
      gates.firstRequestCommitRate.floor,
      claimable,
    ),

    structuralContract: {
      floor: gates.structuralContract.floor,
      accepted: commits,
      clean: commits - violations.length,
      rate: commits === 0 ? null : (commits - violations.length) / commits,
      meetsFloor: commits === 0 ? null : violations.length === 0,
      notARate:
        'invariant potrubí, ne míra kvality modelu: čitatelem je přijatý kandidát bez strukturální vady, ' +
        'ne FULFILLED. Vydávat ho za míru úspěšnosti by obešlo AC úlohy přesně tam, kde na ní záleží.',
      violations,
    },

    perClassFloors: classAggregates(editOutcomes, protocol),

    clustered: {
      rate: clustered.rate,
      successes: clustered.successes,
      trials: clustered.trials,
      standardError: clustered.standardError,
      interval: clustered.interval,
      meetsClusterFloor: clustered.meetsClusterFloor,
      clusters: clustered.clusters.map(({ world, trials, successes }) => ({ world, trials, successes })),
    },
    wilsonCaveat: gates.wilsonCaveat,

    timeToCommit: timeToCommitOf(candidates),
    commitsWithoutSecondCall: {
      commits,
      withoutSecondCall: commits,
      share: commits === 0 ? null : 1,
      structural: true,
      honestNote:
        'P1 pošle na každý případ právě jedno volání poskytovatele a druhé nemá kde vzniknout — ' +
        'opravná dávka je mechanická a běží uvnitř téhož požadavku. Ta jednička je tedy vlastnost potrubí, ' +
        'ne naměřený úspěch modelu, a naměřitelná bude až tam, kde bude existovat cesta se znovu zeptat.',
    },
    threeEditSession: {
      measuredDirectly: true,
      sessionsPassed: input.edit.sessionsPassed,
      sessionsCompleted: input.edit.sessionsCompleted,
      sessionsPlanned: input.edit.sessionsPlanned,
      rate: input.edit.sessionSuccessRate,
      turnsPassed: input.edit.turnsPassed,
      turnsRun: input.edit.turnsRun,
      turnRate: input.edit.turnSuccessRate,
      independenceEstimate: input.edit.independenceEstimate,
      contrastNote:
        'rate je počítaná z relací (passed/completed), NIKDY z tahů. independenceEstimate je turnRate³, ' +
        'tedy přesně ten zakázaný dopočet — vykazuje se vedle, protože rozdíl mezi nimi je nález.',
    },

    findings: {
      frozenBodyMatches: input.edit.frozenBodyMatches,
      harnessFailures: [...input.create.failures, ...input.edit.failures].map((failure) => ({
        caseId: failure.caseId,
        kind: failure.kind,
        detail: failure.detail,
      })),
    },
    cases: candidates,
  };
}

/**
 * Rozdělení „kolik volání stálo přijetí kandidáta".
 *
 * **Jednotkou jsou volání poskytovatele, ne vteřiny.** Nástěnný čas by z artefaktu
 * udělal něco, co se nedá reprodukovat ani porovnat mezi běhy — a měřil by
 * latenci proxy, ne model. Zmrazený protokol navíc mluví o téže ose:
 * *„oprava se počítá jako tentýž uživatelský požadavek"*.
 */
function timeToCommitOf(candidates: readonly Candidate[]): TimeToCommit {
  const committed = candidates.filter((candidate) => candidate.accepted);
  return {
    unit: 'providerRequests',
    committedOnRawEmission: committed.filter((candidate) => candidate.repairs === 0).length,
    committedAfterOneRepair: committed.filter((candidate) => candidate.repairs === 1).length,
    neverCommitted: candidates.length - committed.length,
    maxRequestsUsed: candidates.length === 0 ? 0 : 1,
    honestNote:
      'jedno volání na případ je strop potrubí P1, ne naměřený výsledek: distribuce proto nemá ocas. ' +
      'Mechanická oprava jmenovatel nezvedá, protože podle protokolu leží uvnitř téhož požadavku.',
    byCase: candidates.map((candidate) => ({ id: candidate.id, requests: candidate.accepted ? 1 : null })),
  };
}

// ---------------------------------------------------------------------------
// Zápis — jediné místo, které se dotkne vyhrazeného jména
// ---------------------------------------------------------------------------

/**
 * **Jediný zapisovatel** reportu brány.
 *
 * Nález u T18 to žádá jmenovitě: dokud vyhrazené jméno nemá jediného zapisovatele,
 * obejde bránu kdokoli obyčejným `writeFileSync` a nic nezčervená. Kdo tuhle
 * funkci obejde, obejde s ní i `gate` blok — a to je změna, kterou je vidět v
 * diffu, ne opomenutí. Jméno samo má jedinou definici, v `./live`.
 */
export function writeKillGateReport(report: KillGateReport, root: string = process.cwd()): string {
  const path = join(root, 'evals', KILL_GATE_REPORT);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}
