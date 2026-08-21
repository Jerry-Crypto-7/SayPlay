/**
 * Proč se dnes emise odmítají (P11 T12).
 *
 * ## Co se měří
 *
 * Všech 40 zmrazených záznamů se protáhne **produkční rozhodovací cestou** a
 * zapíše se, kde a proč se zastavily. Výsledkem je histogram důvodů — ne dojem
 * z toho, co model dělá špatně, ale spočítaná čísla nad korpusem, který byl
 * zamrazený dřív, než tenhle soubor vznikl.
 *
 * Měření je **odečet, ne brána**. Nic tu nemá práh: T12 dodává základnu, proti
 * které se v T13 porovnává podíl aplikovaných.
 *
 * ## Dvě třídy příčin, a proč právě ty dvě
 *
 * AC žádá oddělit **nedohratelnost** od **nepřesné interpretace**. Rozdíl je
 * v tom, jestli má odmítnutí kam ustoupit:
 *
 * - **`unwinnable` (nedohratelnost)** — svět se postavil, ale svědek nedojde do
 *   výhry. Není to nepochopená věta; je to svět, který se nedá dohrát, a
 *   přijmout ho by porušilo jediné tvrzení, na kterém projekt stojí (*nic
 *   vadného neprojde přijetím*). Tady odmítnutí zůstává i po T13.
 * - **`imprecise` (nepřesná interpretace)** — model napsal něco, co znamená
 *   jinou věc, než měl napsat: neznámé pole, osiřelý odkaz, cesta, která
 *   v dokumentu neexistuje, mechanika mimo slovník. Svět se buď vůbec
 *   nepostaví, nebo se postaví jiný. Tohle je materiál pro T13 — existuje
 *   nejbližší legální varianta, na kterou se dá doletět.
 *
 * **Hranice mezi třídami vede právě u `witness`, a plyne z aritmetiky, ne
 * z chuti.** Jediná sporná fáze je `lowering` (mechanika není ve slovníku IR).
 * Kdyby se počítala jako nedohratelnost, zůstala by odmítnutá i po T13 — a
 * v editační větvi je devět svědků plus dvě snížení, takže by strop podílu
 * aplikovaných byl 14 z 25 = 0,56, tedy **pod prahem 0,6, který si T13
 * předepisuje**. Zadání plánu tím samo říká, kam `lowering` patří: mezi
 * opravitelné.
 *
 * ## Odkud se bere rozhodnutí
 *
 * `validateEmission` z offline řetězce (T17) — týž řetěz a totéž pořadí, jaké
 * jede `POST /api/emit` (`src/model/certify.ts`), spuštěný vedle endpointu a
 * proti němu porovnávaný. Editační větev jede rovnou přes produkční `routePatch`
 * a `commitRoutedParts`. **Druhá implementace téhož rozhodnutí tu nevzniká**:
 * kdyby si měření soudilo po svém, měřilo by vlastní představu.
 *
 * Základní svět editace se bere z **offline certifikace** zmrazeného světa, ne
 * z endpointu — měření musí jet bez běžícího serveru (`Verify: local`).
 * `sealSimHash` počítá systém, takže dokument je bajtově týž, jaký by vydal
 * `/api/emit`.
 *
 * ## Co tohle měření NEDĚLÁ
 *
 * Nespouští mechanickou opravu (`repairEmission`). Produkční emisní cesta ji
 * nespouští taky — je to stadium offline řetězce, ne endpointu — a otázka zní
 * „proč se odmítá **dnes**".
 *
 * Spuštění: `npm run measure:rejects`
 */

import type { Operation } from 'rfc6902';

import { commitRoutedParts } from '../src/app/api/edit/commit';
import type { WorldDoc } from '../src/ir/worlddoc';
import { routePatch } from '../src/patch/router';

import { frozenResponses, validateEmission, type FrozenResponse } from './harness/chain';

export const RESPONSES_PATH = 'evals/frozen/responses/index.jsonl';
export const REPORT_PATH = 'evals/reject-causes.json';

/**
 * Fáze, ve kterých se dnes odmítá. Sjednocení obou větví: tvorba končí ve
 * `validateEmission`, editace navíc v routeru a při aplikaci patche.
 */
export type RejectStage = 'schema' | 'references' | 'look' | 'lowering' | 'witness' | 'routing' | 'apply';

const ALL_STAGES: readonly RejectStage[] = ['schema', 'references', 'look', 'lowering', 'witness', 'routing', 'apply'];

export type RejectCause = 'unwinnable' | 'imprecise';

/** Jediná fáze, po které svět stojí a přesto se nedá dohrát. Zdůvodnění nahoře. */
const UNWINNABLE_STAGES: ReadonlySet<RejectStage> = new Set<RejectStage>(['witness']);

export function causeOf(stage: RejectStage): RejectCause {
  return UNWINNABLE_STAGES.has(stage) ? 'unwinnable' : 'imprecise';
}

export type Outcome =
  /** Svět se certifikoval (tvorba), nebo se patch commitl (editace). */
  | 'applied'
  /** Emise sama deklarovala `NO_FIT`. Poctivé odmítnutí sebe sama, ne vada. */
  | 'declined'
  | 'rejected';

export interface CaseOutcome {
  readonly id: string;
  readonly branch: 'create' | 'edit';
  readonly outcome: Outcome;
  /** `null` u `applied` i u `declined` — obojí se nikde nezastavilo. */
  readonly stage: RejectStage | null;
  readonly reason: string;
  readonly cause: RejectCause | null;
  readonly detail: string;
}

export interface BranchSummary {
  readonly total: number;
  readonly applied: number;
  readonly declined: number;
  readonly rejected: number;
  readonly unwinnable: number;
  readonly imprecise: number;
  /** Podíl z celé větve, ne z odmítnutých. Proti tomuhle číslu stojí práh T13. */
  readonly appliedShare: number;
}

export interface RejectReport {
  readonly source: string;
  readonly total: number;
  readonly applied: number;
  readonly declined: number;
  readonly rejected: number;
  /** Histogram důvodů. Součet položek se rovná `rejected`. */
  readonly byReason: Readonly<Record<string, number>>;
  /** Týž součet jinak rozdělený — podle fáze, ve které se to zlomilo. */
  readonly byStage: Readonly<Record<string, number>>;
  /** Oddělení, které žádá AC. Součet obou položek se rovná `rejected`. */
  readonly byCause: Readonly<Record<RejectCause, number>>;
  /** Které fáze do které třídy spadají — aby se rozdělení dalo přečíst, ne uhodnout. */
  readonly causeStages: Readonly<Record<RejectCause, readonly RejectStage[]>>;
  readonly branches: Readonly<Record<'create' | 'edit', BranchSummary>>;
  readonly appliedShare: number;
  readonly cases: readonly CaseOutcome[];
}

// ---------------------------------------------------------------------------
// Jeden záznam
// ---------------------------------------------------------------------------

function createOutcome(frozen: FrozenResponse): CaseOutcome {
  const validation = validateEmission(frozen.body);
  const base = {
    id: frozen.forPrompt,
    branch: 'create' as const,
    reason: validation.reason,
    detail: validation.detail,
  };

  if (validation.stage === 'declined') return { ...base, outcome: 'declined', stage: null, cause: null };
  if (validation.ok) return { ...base, outcome: 'applied', stage: null, cause: null };

  const stage = validation.stage as RejectStage;
  return { ...base, outcome: 'rejected', stage, cause: causeOf(stage) };
}

function editOutcome(frozen: FrozenResponse, baseDoc: WorldDoc): CaseOutcome {
  const id = frozen.forPrompt;
  const branch = 'edit' as const;

  const routed = routePatch({ operations: frozen.body as readonly Operation[] });
  if (routed.verdict === 'REJECTED')
    return {
      id,
      branch,
      outcome: 'rejected',
      stage: 'routing',
      reason: routed.reason,
      cause: causeOf('routing'),
      detail: `${routed.pointer || '/'}: ${routed.detail}`,
    };

  const committed = commitRoutedParts(
    baseDoc,
    routed.patches.map((part) => ({
      part: part.part,
      baseRevision: part.part === 'sim' ? baseDoc.simRevision : baseDoc.lookRevision,
      operations: part.operations,
    })),
  );

  if (committed.outcome === 'CERTIFIED')
    return {
      id,
      branch,
      outcome: 'applied',
      stage: null,
      reason: 'CERTIFIED',
      cause: null,
      detail: `${committed.applied.join('+')}, ${committed.changedLeaves.length} listů`,
    };

  const rejection = committed.rejections[0];
  const stage = rejection.stage as RejectStage;
  return {
    id,
    branch,
    outcome: 'rejected',
    stage,
    reason: rejection.reason,
    cause: causeOf(stage),
    detail: `${rejection.pointer || '/'}: ${rejection.detail}`,
  };
}

// ---------------------------------------------------------------------------
// Běh nad celým korpusem
// ---------------------------------------------------------------------------

function summarize(cases: readonly CaseOutcome[]): BranchSummary {
  const count = (outcome: Outcome): number => cases.filter((entry) => entry.outcome === outcome).length;
  const byCause = (cause: RejectCause): number => cases.filter((entry) => entry.cause === cause).length;
  const applied = count('applied');
  return {
    total: cases.length,
    applied,
    declined: count('declined'),
    rejected: count('rejected'),
    unwinnable: byCause('unwinnable'),
    imprecise: byCause('imprecise'),
    appliedShare: cases.length === 0 ? 0 : applied / cases.length,
  };
}

/**
 * Histogram se sestupným pořadím klíčů: nejčastější důvod je první řádek
 * artefaktu, při shodě rozhoduje abeceda, takže pořadí je stabilní napříč běhy.
 */
function histogram(keys: readonly string[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const key of keys) tally[key] = (tally[key] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(tally).sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1])),
  );
}

export function measureRejects(): RejectReport {
  const responses = frozenResponses();
  const byId = new Map(responses.map((response) => [response.forPrompt, response]));

  // Základní světy se certifikují jednou, i když na nich stojí víc úprav.
  const baseDocs = new Map<string, WorldDoc | null>();
  const baseDocOf = (id: string): WorldDoc | null => {
    if (!baseDocs.has(id)) {
      const base = byId.get(id);
      if (base === undefined) throw new Error(`editační záznam jmenuje základní svět ${id}, který v korpusu není`);
      baseDocs.set(id, validateEmission(base.body).doc);
    }
    return baseDocs.get(id) ?? null;
  };

  const cases: CaseOutcome[] = responses.map((frozen) => {
    if (frozen.branch === 'create') return createOutcome(frozen);
    const baseWorld = frozen.baseWorld;
    if (baseWorld === undefined) throw new Error(`editační záznam ${frozen.forPrompt} nejmenuje základní svět`);
    const baseDoc = baseDocOf(baseWorld);
    // Svět, který se nezapečetil, nemá co patchovat. Je to naměřený stav korpusu,
    // ne chyba běhu — a patří do téže třídy jako všechno ostatní, co se dá
    // spravit tím, že se emise trefí lépe.
    if (baseDoc === null)
      return {
        id: frozen.forPrompt,
        branch: 'edit',
        outcome: 'rejected',
        stage: 'references',
        reason: 'BASE_WORLD_UNSEALED',
        cause: causeOf('references'),
        detail: `základní svět ${baseWorld} se nezapečetil, takže patch nemá nad čím běžet`,
      };
    return editOutcome(frozen, baseDoc);
  });

  const rejected = cases.filter((entry) => entry.outcome === 'rejected');
  const all = summarize(cases);

  return {
    source: RESPONSES_PATH,
    total: cases.length,
    applied: all.applied,
    declined: all.declined,
    rejected: rejected.length,
    byReason: histogram(rejected.map((entry) => entry.reason)),
    byStage: histogram(rejected.map((entry) => entry.stage as RejectStage)),
    byCause: {
      unwinnable: rejected.filter((entry) => entry.cause === 'unwinnable').length,
      imprecise: rejected.filter((entry) => entry.cause === 'imprecise').length,
    },
    causeStages: {
      unwinnable: ALL_STAGES.filter((stage) => UNWINNABLE_STAGES.has(stage)),
      imprecise: ALL_STAGES.filter((stage) => !UNWINNABLE_STAGES.has(stage)),
    },
    branches: {
      create: summarize(cases.filter((entry) => entry.branch === 'create')),
      edit: summarize(cases.filter((entry) => entry.branch === 'edit')),
    },
    appliedShare: all.appliedShare,
    cases,
  };
}
