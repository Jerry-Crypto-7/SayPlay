/**
 * Offline řetězec (T17) — zmrazené odpovědi protažené **celým** potrubím.
 *
 * Pět stadií, v tomhle pořadí a bez výjimky: **emise → validace → oprava →
 * commit → replay**. Každé zapíše záznam s `requestId`, hashem svého vstupu
 * a hashem svého výstupu, a `inputHash` stadia N se rovná `outputHash` stadia
 * N−1. To řetězení je celý smysl (review v4/T17): pět záznamů se stejným
 * `requestId` šlo vyrobit dodatečně na jednom místě, kdežto řetěz hashů zfalšuje
 * jedině ten, kdo doopravdy provede celý řetězec.
 *
 * ## Co je první vstup — a proč ne `emission`
 *
 * `provenance.bodySha256` (`src/model/client.ts`), tedy sha256 nad
 * `JSON.stringify(record.body)` zmrazeného záznamu. **Ne `emission`**: obálkové
 * anotace se na emisní cestě loupou (`ENVELOPE_ANNOTATIONS`), takže u čtyř
 * záznamů (`C12`–`C15`) `emission` bajtově shodné se zmrazeným tělem není a být
 * nemůže. Řetěz navázaný na `emission` by tiše minul právě na nich. Harness si
 * ten hash počítá **sám ze zmrazeného souboru** a proti `provenance` ho jen
 * porovnává — kdyby ho přečetl z odpovědi, kotvil by řetěz k tvrzení té strany,
 * kterou má měřit.
 *
 * ## Proč harness validuje znovu, i když to endpoint dělá taky
 *
 * Není to druhá implementace, je to **druhé spuštění téhož produkčního řetězu**
 * mimo endpoint, jehož výsledek se proti endpointu porovnává. Rozpor mezi tím,
 * co vrátí `POST /api/emit`, a tím, co dá tentýž řetěz vedle, je nález
 * (`pipeline-disagreement`), ne kosmetika — a bez druhého běhu by ho nikdo
 * neviděl.
 *
 * ## Mapování výsledku potrubí na `Evidence` scoreru
 *
 * Tvorba drží **tutéž konvenci jako T16** (`evals/scorer/__tests__/corpus.ts`):
 * `declined` jedině tehdy, když emise sama deklarovala `simOutcome: "NO_FIT"`,
 * jinak `emitted`. Odmítnutí uvnitř 200 (schéma, odkazy, snížení, svědek)
 * verdikt **nesnižuje tady** — sráží ho scorer vlastními branami, které nad
 * dokumentem znovu staví svět. Kdyby T17 zavedl druhou konvenci, měřil by týž
 * korpus jinou stupnicí než sada, která scorer prokázala.
 *
 * Editace tu konvenci nemá odkud vzít: `corpus.ts` končí u `commitPart` a na
 * recertifikaci svědka (`certifySim`) nedosáhne. Mapování proto vychází ze
 * slovníku verdiktů zmrazeného protokolu (`evalSet.verdicts`) — viz `editEvidence`.
 *
 * ## Oprava běží jen tam, kde má co opravovat
 *
 * `repairEmission` (T15) se spouští **až když produkční validace odmítla**. Nad
 * platnou emisí by kanonizace a výchozí hodnoty dokument změnily (`revision.reset`,
 * `order.rules`) a commitl by se jiný svět, než jaký endpoint certifikoval.
 * U editace je oprava definovaná nad emisí světa, ne nad patchem, takže se
 * nespouští nikdy. Obojí se zapisuje jako **identitní stadium** s uvedeným
 * důvodem: chybějící stadium je selhání běhu, stadium které nic neudělalo a
 * řeklo to, není.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { commitRoutedParts, type CommitOutcome } from '../../src/app/api/edit/commit';
import { buildRuntimeWorld } from '../../src/ir/build';
import { findDanglingReferences } from '../../src/ir/references';
import {
  canonical,
  declinedEmissionSchema,
  peelEnvelope,
  sealSimHash,
  validateLook,
  worldEmissionSchema,
  type WorldDoc,
} from '../../src/ir/worlddoc';
import { repairEmission } from '../../src/patch/repair';
import { routePatch } from '../../src/patch/router';
import { verifyWitness, type VerifiableWorld, type VerifyResult } from '../../src/verify/witness';
import { loadContracts, scoreCase, type Contract, type Evidence, type Verdict } from '../scorer/semantic';

/**
 * Kořen se bere z `process.cwd()`, ne z `import.meta.url`: řetězec běží pod
 * Playwrightem, který projektové `.ts` překládá do CommonJS, kde je `import.meta`
 * syntaktická chyba. Táž konvence jako `FROZEN_DIR` v `src/model/client.ts`.
 */
const FROZEN_DIR = join(process.cwd(), 'evals', 'frozen');

// ---------------------------------------------------------------------------
// Stadia a jejich záznamy
// ---------------------------------------------------------------------------

export const STAGES = ['emit', 'validate', 'repair', 'commit', 'replay'] as const;
export type StageName = (typeof STAGES)[number];

export interface StageRecord {
  readonly caseId: string;
  readonly stage: StageName;
  /** Pořadí uvnitř případu. Monotónní, bez děr. */
  readonly order: number;
  /** Korelační ID požadavku, ze kterého tenhle případ vznikl (T7). */
  readonly requestId: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly detail: string;
}

/** sha256 nad `JSON.stringify` — týž tvar, jakým `client.ts` počítá `bodySha256`. */
export function stageHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
}

export interface Ledger {
  readonly records: readonly StageRecord[];
  /** Stadium, které vyrobilo nový výstup. */
  write(stage: StageName, output: unknown, detail: string): void;
  /** Stadium, které vědomě nic nezměnilo. `outputHash` se rovná `inputHash`. */
  identity(stage: StageName, detail: string): void;
}

/** Exportovaný kvůli `live.ts` (T18): živý běh vede týž řetěz jiným vstupem. */
export function ledger(caseId: string, requestId: string, firstInputHash: string): Ledger {
  const records: StageRecord[] = [];
  let previous = firstInputHash;
  const push = (stage: StageName, outputHash: string, detail: string): void => {
    records.push({ caseId, stage, order: records.length, requestId, inputHash: previous, outputHash, detail });
    previous = outputHash;
  };
  return {
    records,
    write: (stage, output, detail) => push(stage, stageHash(output), detail),
    identity: (stage, detail) => push(stage, previous, detail),
  };
}

// ---------------------------------------------------------------------------
// Selhání běhu
// ---------------------------------------------------------------------------

export type FailureKind =
  /** Stadium chybí, přebývá, nebo je mimo pořadí. */
  | 'stage-missing'
  /** `inputHash` stadia N se nerovná `outputHash` stadia N−1. */
  | 'chain-broken'
  /** První vstup neodpovídá zmrazené odpovědi z manifestu. */
  | 'first-hash'
  /** Verdikt z prohlížeče se rozešel s offline předpovědí. */
  | 'browser-divergence'
  /** Endpoint tvrdí něco jiného, než co dá tentýž řetěz spuštěný vedle. */
  | 'pipeline-disagreement'
  /** Řetěz se nedal spustit — rozbité prostředí, ne naměřený výsledek. */
  | 'transport'
  /** Naměřená míra `FULFILLED` se nerovná zmrazenému prahu. */
  | 'threshold';

export interface ChainFailure {
  readonly caseId: string;
  readonly kind: FailureKind;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Vstupy: zmrazený korpus
// ---------------------------------------------------------------------------

export interface FrozenResponse {
  readonly synthetic: boolean;
  readonly forPrompt: string;
  readonly branch: 'create' | 'edit';
  readonly baseWorld?: string;
  readonly expectedVerdict: Verdict;
  readonly sha256: string;
  readonly body: unknown;
}

export function frozenResponses(): readonly FrozenResponse[] {
  return readFileSync(join(FROZEN_DIR, 'responses', 'index.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FrozenResponse);
}

/**
 * Práh ze **zmrazeného** protokolu, ne z konfigurace běhu.
 *
 * `offlineFulfilledThreshold.exact` a jeho pravidlo: *„T17 vyžaduje PŘESNOU
 * shodu s deklarovanou distribucí, ne minimum. Odchylka kterýmkoli směrem je
 * selhání potrubí nebo scoreru."* Práh se proto porovnává rovností.
 */
export function frozenThreshold(): number {
  const protocol = JSON.parse(readFileSync(join(FROZEN_DIR, 'protocol.v1.json'), 'utf8')) as {
    syntheticResponses: { offlineFulfilledThreshold: { exact: number } };
  };
  return protocol.syntheticResponses.offlineFulfilledThreshold.exact;
}

// ---------------------------------------------------------------------------
// Doprava — Playwright zůstává v testu, ne tady
// ---------------------------------------------------------------------------

export interface PostResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface Transport {
  /** POST na běžící produkční server. */
  readonly post: (path: '/api/emit' | '/api/edit', data: unknown) => Promise<PostResult>;
  /** `runTrace` **v prohlížeči** — přes `window.__worldsmith.verify`. */
  readonly replay: (world: unknown, witness: unknown) => Promise<VerifyResult>;
}

// ---------------------------------------------------------------------------
// Produkční validační řetěz, spuštěný vedle endpointu
// ---------------------------------------------------------------------------

export type ValidationStage = 'schema' | 'references' | 'look' | 'lowering' | 'witness' | 'declined';

export interface Validation {
  readonly ok: boolean;
  /** Kde se to zlomilo; `null` = prošlo celé. `declined` = poctivé `NO_FIT`. */
  readonly stage: ValidationStage | null;
  readonly reason: string;
  readonly detail: string;
  /** Zapečetěný dokument, když emise prošla schématem. */
  readonly doc: WorldDoc | null;
  readonly world: VerifiableWorld | null;
  readonly sceneBuilt: boolean;
}

/**
 * Týž řetěz a totéž pořadí jako `POST /api/emit`: anotace se loupou první,
 * odkazy se rozpouštějí **před** snížením do IR.
 *
 * **`annotations` se předávají zvlášť, a je to nutnost, ne pohodlí.** Endpoint
 * vrací `emission` už oloupanou, takže `simOutcome: "NO_FIT"` v ní nezůstane —
 * druhý průchod nad ní by `C14` a `C15` prohlásil za vadu schématu (`sim: null`
 * neprojde `worldEmissionSchema`) místo za poctivé odmítnutí. Dokument a jeho
 * anotace jsou dvě půlky téhož vstupu a musí cestovat spolu.
 *
 * `sceneBuilt` je platný `look`, ne vykreslený snímek. V P1 vzhled emituje
 * systémový default a `Stage.tsx` staví pevnou scénu, takže jediný oracle na
 * „scéna se postaví", který tady existuje, je `validateLook` — schéma plus
 * konečnost všech číselných hodnot. Generátor rodin je až P5.
 */
export function validateEmission(body: unknown, annotations?: Record<string, unknown>): Validation {
  const empty = { doc: null, world: null } as const;
  const peeled = peelEnvelope(body);
  if (peeled === null)
    return { ...empty, ok: false, stage: 'schema', reason: 'NOT_A_DOCUMENT', detail: 'the emission body is not a JSON object', sceneBuilt: false };

  const marks = annotations ?? peeled.annotations;
  const look = validateLook((peeled.document as { look?: unknown }).look);

  if (marks.simOutcome === 'NO_FIT') {
    const declined = declinedEmissionSchema.safeParse(peeled.document);
    if (!declined.success)
      return { ...empty, ok: false, stage: 'schema', reason: 'SCHEMA_VIOLATION', detail: declined.error.issues[0].message, sceneBuilt: look.ok };
    if (!look.ok) return { ...empty, ok: false, stage: 'look', reason: 'LOOK_INVALID', detail: look.issues[0], sceneBuilt: false };
    return { ...empty, ok: true, stage: 'declined', reason: 'NO_FIT_DECLARED', detail: 'the emission declined the sim part', sceneBuilt: true };
  }

  const parsed = worldEmissionSchema.safeParse(peeled.document);
  if (!parsed.success)
    return { ...empty, ok: false, stage: 'schema', reason: 'SCHEMA_VIOLATION', detail: parsed.error.issues[0].message, sceneBuilt: look.ok };

  const dangling = findDanglingReferences(parsed.data);
  if (dangling.length > 0)
    return {
      ...empty,
      ok: false,
      stage: 'references',
      reason: 'DANGLING_REFERENCE',
      detail: `${dangling[0].where} names no declared ${dangling[0].namespace} ${dangling[0].name}`,
      sceneBuilt: look.ok,
    };

  if (!look.ok) return { ...empty, ok: false, stage: 'look', reason: 'LOOK_INVALID', detail: look.issues[0], sceneBuilt: false };

  const doc = sealSimHash(parsed.data) as WorldDoc;
  const built = buildRuntimeWorld(parsed.data.sim);
  if (!built.ok)
    return { doc, world: null, ok: false, stage: 'lowering', reason: built.reason, detail: built.issues[0] ?? 'no detail', sceneBuilt: true };

  const verdict = verifyWitness(built.world, built.world.trace);
  if (verdict.verdict === 'REJECTED')
    return { doc, world: built.world, ok: false, stage: 'witness', reason: verdict.reason, detail: verdict.detail, sceneBuilt: true };

  return { doc, world: built.world, ok: true, stage: null, reason: 'CERTIFIED', detail: verdict.snapshotHash, sceneBuilt: true };
}

// ---------------------------------------------------------------------------
// Výsledek jednoho případu a celého běhu
// ---------------------------------------------------------------------------

export type StopStage = ValidationStage | 'routing' | 'apply' | null;

export interface CaseResult {
  readonly id: string;
  readonly branch: 'create' | 'edit';
  /** Verdikt, který korpus deklaruje. Neřídí nic — porovnává se s naměřeným. */
  readonly declared: Verdict;
  readonly verdict: Verdict;
  readonly gates: readonly string[];
  readonly unmet: readonly string[];
  /** Kde se produkční řetěz zlomil; `null` = prošel. */
  readonly stoppedAt: StopStage;
  readonly repairApplied: readonly string[];
  readonly browserReplayed: boolean;
  /** Hash koncového stavu z prohlížeče a jeho offline předpověď. */
  readonly browserHash: string | null;
  readonly offlineHash: string | null;
  readonly records: readonly StageRecord[];
  readonly failures: readonly ChainFailure[];
}

export interface ChainReport {
  readonly cases: readonly CaseResult[];
  readonly records: readonly StageRecord[];
  /** `ROBUST` a `FULFILLED` se vykazují ODDĚLENĚ (`evalSet.reportSeparation`). */
  readonly counts: Readonly<Record<Verdict, number>>;
  readonly fulfilled: number;
  readonly threshold: number;
  readonly thresholdMet: boolean;
  /** Kolik případů se doopravdy přehrálo v prohlížeči. */
  readonly browserReplays: number;
  readonly failures: readonly ChainFailure[];
  readonly ok: boolean;
}

// ---------------------------------------------------------------------------
// Kontrola řetězení — běh na ní selže
// ---------------------------------------------------------------------------

/**
 * Které stadium smí být identitní.
 *
 * **Jen `repair`, a je to celá obrana proti nejlevnějšímu podvrhu.** Řetěz, ve
 * kterém se všech pět hashů rovná, je formálně zřetězený — každý vstup se rovná
 * předchozímu výstupu — a projde kontrolou návaznosti bez jediné výhrady.
 * Netvrdí ale nic: pět identitních kroků znamená, že se nic neprovedlo. Emise,
 * commit i replay z podstaty vyrábějí jinou hodnotu, než jakou dostaly, takže
 * u nich je `outputHash === inputHash` důkaz, že se záznam dopsal místo aby
 * vznikl. Oprava je jediná, která legálně nemá co dělat.
 */
const MAY_BE_IDENTITY: ReadonlySet<StageName> = new Set<StageName>(['repair']);

/**
 * Ověří, že případ má všech pět stadií, v pořadí, zřetězená hashem, a že první
 * vstup je zmrazená odpověď z manifestu.
 */
export function chainFailures(
  caseId: string,
  records: readonly StageRecord[],
  firstInputHash: string,
): readonly ChainFailure[] {
  const found: ChainFailure[] = [];
  const fail = (kind: FailureKind, detail: string): void => void found.push({ caseId, kind, detail });

  if (records.length !== STAGES.length)
    fail('stage-missing', `${records.length} stadií místo ${STAGES.length}: ${records.map((record) => record.stage).join(',')}`);

  STAGES.forEach((stage, index) => {
    const record = records[index];
    if (record === undefined) return void fail('stage-missing', `stadium ${stage} chybí`);
    if (record.stage !== stage) fail('stage-missing', `na pozici ${index} je ${record.stage}, čekalo se ${stage}`);
    if (record.order !== index) fail('stage-missing', `${record.stage} nese order ${record.order}, čekalo se ${index}`);
    if (record.inputHash === record.outputHash && !MAY_BE_IDENTITY.has(record.stage))
      fail('chain-broken', `${record.stage} nic nezměnilo — identitní smí být jen ${[...MAY_BE_IDENTITY].join(', ')}`);
  });

  if (records.length > 0 && records[0].inputHash !== firstInputHash)
    fail('first-hash', `první vstup je ${records[0].inputHash}, zmrazená odpověď má ${firstInputHash}`);

  for (let i = 1; i < records.length; i += 1)
    if (records[i].inputHash !== records[i - 1].outputHash)
      fail(
        'chain-broken',
        `${records[i].stage}.inputHash ${records[i].inputHash} != ${records[i - 1].stage}.outputHash ${records[i - 1].outputHash}`,
      );

  const ids = new Set(records.map((record) => record.requestId));
  if (ids.size > 1) fail('chain-broken', `stadia nesou ${ids.size} různých requestId`);

  return found;
}

// ---------------------------------------------------------------------------
// Replay v prohlížeči
// ---------------------------------------------------------------------------

interface Replayed {
  readonly browser: VerifyResult | null;
  readonly offline: VerifyResult | null;
  readonly failures: readonly ChainFailure[];
}

/**
 * Přehraje svědka **v prohlížeči** a porovná s offline předpovědí.
 *
 * Porovnává se **celý** verdikt, ne jen `snapshotHash`: kdyby se lišil tier,
 * `L_witness` nebo verze runtimu, je to týž druh rozporu (`e2e/witness-replay`).
 * Odmítnutý svědek se přehrává taky — shoda jen na výhře by seděla na jediné
 * cestě, kterou by běh náhodou vybral.
 */
async function replayInBrowser(caseId: string, world: VerifiableWorld | null, transport: Transport): Promise<Replayed> {
  if (world === null) return { browser: null, offline: null, failures: [] };

  const offline = verifyWitness(world, world.trace);
  const browser = await transport.replay(world, world.trace);
  const failures: ChainFailure[] = [];

  if (canonical(browser) !== canonical(offline))
    failures.push({
      caseId,
      kind: 'browser-divergence',
      detail: `prohlížeč ${canonical(browser).slice(0, 160)}, Node ${canonical(offline).slice(0, 160)}`,
    });

  return { browser, offline, failures };
}

const hashOf = (result: VerifyResult | null): string | null =>
  result !== null && result.verdict === 'CERTIFIED' ? result.snapshotHash : null;

// ---------------------------------------------------------------------------
// Větev tvorby
// ---------------------------------------------------------------------------

async function runCreate(frozen: FrozenResponse, contract: Contract, transport: Transport): Promise<CaseResult> {
  const id = frozen.forPrompt;
  const firstInputHash = stageHash(frozen.body);
  const failures: ChainFailure[] = [];

  const response = await transport.post('/api/emit', { promptId: id });
  if (response.status !== 200)
    return transportFailure(id, 'create', frozen, contract, `POST /api/emit vrátil ${response.status}`);

  const requestId = String(response.body.requestId);
  const provenance = response.body.provenance as { bodySha256?: string } | undefined;
  if (provenance?.bodySha256 !== firstInputHash)
    failures.push({
      caseId: id,
      kind: 'first-hash',
      detail: `endpoint hlásí provenance ${String(provenance?.bodySha256)}, zmrazený soubor dává ${firstInputHash}`,
    });

  const log = ledger(id, requestId, firstInputHash);

  // 1 — emise
  const emitted = {
    outcome: response.body.outcome,
    rejection: response.body.rejection,
    annotations: response.body.annotations,
    emission: response.body.emission,
    doc: response.body.doc,
  };
  log.write('emit', emitted, `${String(response.body.outcome)} přes POST /api/emit`);

  // 2 — validace: týž produkční řetěz, spuštěný vedle endpointu
  const annotations = (response.body.annotations as Record<string, unknown> | undefined) ?? {};
  const validation = validateEmission(emitted.emission, annotations);
  log.write(
    'validate',
    { ok: validation.ok, stage: validation.stage, reason: validation.reason, detail: validation.detail },
    validation.ok ? `prošlo (${validation.reason})` : `${String(validation.stage)}/${validation.reason}`,
  );
  failures.push(...createDisagreement(id, response.body, validation));

  // 3 — oprava, jen když validace odmítla
  let effective = validation;
  let repairApplied: readonly string[] = [];
  if (validation.ok) {
    log.identity('repair', 'validace prošla, mechanická oprava se nespouští');
  } else {
    const repaired = repairEmission(emitted.emission);
    repairApplied = repaired.applied.map((step) => step.rule);
    const after = validateEmission(repaired.document, annotations);
    if (after.ok) effective = after;
    log.write(
      'repair',
      {
        applied: repairApplied,
        refused: repaired.refused.map((refusal) => refusal.kind),
        after: { ok: after.ok, stage: after.stage, reason: after.reason },
      },
      `${repairApplied.length === 0 ? 'nic k opravě' : repairApplied.join(', ')} → ${after.ok ? 'validní' : `dál ${String(after.stage)}/${after.reason}`}`,
    );
  }

  // 4 — atomický commit: `simHash` pečetí systém, ne model
  const committed = effective.doc;
  log.write(
    'commit',
    committed ?? { committed: false, reason: `${String(effective.stage)}/${effective.reason}` },
    committed === null ? `necommitnuto: ${String(effective.stage)}/${effective.reason}` : `zapečetěno simHash ${committed.simHash}`,
  );
  if (committed !== null && response.body.doc !== null && canonical(committed) !== canonical(response.body.doc))
    failures.push({ caseId: id, kind: 'pipeline-disagreement', detail: 'zapečetěný dokument se rozešel s tím, co vrátil endpoint' });

  // 5 — replay v prohlížeči
  const replayed = await replayInBrowser(id, effective.world, transport);
  failures.push(...replayed.failures);
  log.write(
    'replay',
    replayed.browser ?? { replayed: false, reason: `${String(effective.stage)}: svět se nepostavil` },
    replayed.browser === null ? 'svět se nepostavil, není co přehrát' : `prohlížeč: ${replayed.browser.verdict}`,
  );

  // Konvence T16: `declined` jedině u deklarovaného `NO_FIT`.
  const evidence: Evidence =
    effective.stage === 'declined'
      ? { kind: 'create', outcome: 'declined', sceneBuilt: effective.sceneBuilt }
      : {
          kind: 'create',
          outcome: 'emitted',
          doc: peelEnvelope(emitted.emission)?.document ?? emitted.emission,
          sceneBuilt: effective.sceneBuilt,
        };

  const score = scoreCase(contract, evidence);
  failures.push(...chainFailures(id, log.records, firstInputHash));

  return {
    id,
    branch: 'create',
    declared: frozen.expectedVerdict,
    verdict: score.verdict,
    gates: score.gates,
    unmet: score.requirements.filter((requirement) => !requirement.met).map((requirement) => requirement.rid),
    stoppedAt: effective.stage === 'declined' ? null : effective.stage,
    repairApplied,
    browserReplayed: replayed.browser !== null,
    browserHash: hashOf(replayed.browser),
    offlineHash: hashOf(replayed.offline),
    records: log.records,
    failures,
  };
}

/** Endpoint a týž řetěz spuštěný vedle si musí odpovídat. */
function createDisagreement(id: string, body: Record<string, unknown>, validation: Validation): readonly ChainFailure[] {
  const endpointStage = (body.rejection as { stage?: string } | null)?.stage ?? null;
  // Endpoint pojmenovává poctivé odmítnutí `declined`, validace stejně.
  const endpointOk = body.outcome === 'CERTIFIED' || body.outcome === 'NO_FIT';
  const expected = validation.ok && validation.stage === null ? null : validation.stage;
  if (endpointOk === validation.ok && endpointStage === expected) return [];
  return [
    {
      caseId: id,
      kind: 'pipeline-disagreement',
      detail: `endpoint ${String(body.outcome)}/${String(endpointStage)}, řetěz vedle ${validation.ok ? 'ok' : 'odmítnuto'}/${String(validation.stage)}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Větev editace
// ---------------------------------------------------------------------------

async function runEdit(
  frozen: FrozenResponse,
  contract: Contract,
  base: FrozenResponse,
  transport: Transport,
): Promise<CaseResult> {
  const id = frozen.forPrompt;
  const firstInputHash = stageHash(frozen.body);

  // Základní svět se bere z **produkční** emisní cesty, ne ze zmrazeného těla:
  // `emitPatch` váže záznam otiskem obsahu `sim`, takže jiný svět skončí 404.
  const emitted = await transport.post('/api/emit', { promptId: base.forPrompt });
  const baseDoc = emitted.status === 200 ? (emitted.body.doc as WorldDoc | null) : null;
  if (baseDoc === null)
    return transportFailure(id, 'edit', frozen, contract, `základní svět ${base.forPrompt} nevydal dokument`);

  const response = await transport.post('/api/edit', {
    worldDoc: baseDoc,
    baseRevision: { sim: baseDoc.simRevision, look: baseDoc.lookRevision },
    promptId: id,
  });
  if (response.status !== 200)
    return transportFailure(id, 'edit', frozen, contract, `POST /api/edit vrátil ${response.status}`);

  const requestId = String(response.body.requestId);
  const failures: ChainFailure[] = [];
  const log = ledger(id, requestId, firstInputHash);

  // 1 — emise patche
  const patch = response.body.patch;
  log.write(
    'emit',
    {
      outcome: response.body.outcome,
      patch,
      applied: response.body.applied,
      changedLeaves: response.body.changedLeaves,
      revisions: response.body.revisions,
      rejections: response.body.rejections,
    },
    `${String(response.body.outcome)} přes POST /api/edit nad ${base.forPrompt}`,
  );
  if (stageHash(patch) !== firstInputHash)
    failures.push({ caseId: id, kind: 'first-hash', detail: 'vrácený patch se rozešel se zmrazeným tělem' });

  // 2 — validace: dráhu rozhodují normalizované cesty, ne štítek (T22)
  const routed = routePatch({ operations: patch as never });
  log.write(
    'validate',
    routed.verdict === 'ROUTED'
      ? { ok: true, lanes: routed.patches.map((part) => part.lane), parts: routed.patches.map((part) => part.part) }
      : { ok: false, reason: routed.reason, pointer: routed.pointer },
    routed.verdict === 'ROUTED' ? `dráhy ${routed.patches.map((part) => part.lane).join(',')}` : `routing/${routed.reason}`,
  );

  // 3 — oprava je definovaná nad emisí světa, ne nad patchem
  log.identity('repair', 'mechanická oprava je definovaná nad emisí světa, ne nad patchem');

  // 4 — atomický commit přes produkční `commitRoutedParts`
  const committed: CommitOutcome | null =
    routed.verdict === 'ROUTED'
      ? commitRoutedParts(
          baseDoc,
          routed.patches.map((part) => ({
            part: part.part,
            baseRevision: part.part === 'sim' ? baseDoc.simRevision : baseDoc.lookRevision,
            operations: part.operations,
          })),
        )
      : null;
  log.write(
    'commit',
    committed === null
      ? { committed: false, reason: routed.verdict === 'ROUTED' ? 'unreachable' : routed.reason }
      : {
          outcome: committed.outcome,
          applied: committed.applied,
          changedLeaves: committed.changedLeaves,
          after: committed.after,
        },
    committed === null
      ? `necommitnuto: routing/${routed.verdict === 'ROUTED' ? 'unreachable' : routed.reason}`
      : `${committed.outcome}, aplikováno ${committed.applied.join('+') || 'nic'}`,
  );
  failures.push(...editDisagreement(id, response.body, committed));

  // 5 — replay v prohlížeči nad světem PO commitu
  const after = committed !== null && committed.applied.includes('sim') ? committed.after : null;
  const built = after === null ? null : buildRuntimeWorld(after.sim);
  const replayed = await replayInBrowser(id, built !== null && built.ok ? built.world : null, transport);
  failures.push(...replayed.failures);
  log.write(
    'replay',
    replayed.browser ?? { replayed: false, reason: 'sim se necommitla, není co přehrát' },
    replayed.browser === null ? 'sim se necommitla, není co přehrát' : `prohlížeč: ${replayed.browser.verdict}`,
  );

  const rejection = committed?.rejections[0] ?? null;
  const score = scoreCase(contract, editEvidence(baseDoc, committed, routed.verdict === 'ROUTED' ? null : routed.reason));
  failures.push(...chainFailures(id, log.records, firstInputHash));

  return {
    id,
    branch: 'edit',
    declared: frozen.expectedVerdict,
    verdict: score.verdict,
    gates: score.gates,
    unmet: score.requirements.filter((requirement) => !requirement.met).map((requirement) => requirement.rid),
    stoppedAt: routed.verdict !== 'ROUTED' ? 'routing' : rejection === null ? null : (rejection.stage as StopStage),
    repairApplied: [],
    browserReplayed: replayed.browser !== null,
    browserHash: hashOf(replayed.browser),
    offlineHash: hashOf(replayed.offline),
    records: log.records,
    failures,
  };
}

/**
 * Odmítnutí commitu na `Evidence`, podle slovníku verdiktů zmrazeného protokolu.
 *
 * | odmítnutí | `Evidence.outcome` | verdikt | proč |
 * |---|---|---|---|
 * | `routing`, `apply`, `references` | `fault` | `FAULT` | *„nevalidní výstup"* |
 * | `lowering` | `declined` | `NO_FIT` | *„mechanika není v gramatice"* |
 * | `witness` | `fallback` | `ROBUST` | svět stojí, kontrakt nesplněn |
 *
 * Sloučit je pod jeden `fault` by smazalo přesně ten rozdíl, kvůli kterému
 * endpoint vydává `rejection.stage` — a `evalSet.reportSeparation` ho vyžaduje.
 */
export function editEvidence(before: WorldDoc, committed: CommitOutcome | null, routingReason: string | null): Evidence {
  if (committed === null)
    return { kind: 'edit', outcome: 'fault', sceneBuilt: true, detail: `routing/${String(routingReason)}` };
  if (committed.outcome === 'CERTIFIED')
    return { kind: 'edit', outcome: 'committed', before, after: committed.after, sceneBuilt: true };

  const rejection = committed.rejections[0];
  const detail = `${rejection.stage}/${rejection.reason}`;
  if (rejection.stage === 'lowering') return { kind: 'edit', outcome: 'declined', sceneBuilt: true, detail };
  if (rejection.stage === 'witness') return { kind: 'edit', outcome: 'fallback', sceneBuilt: true, detail };
  return { kind: 'edit', outcome: 'fault', sceneBuilt: true, detail };
}

function editDisagreement(id: string, body: Record<string, unknown>, committed: CommitOutcome | null): readonly ChainFailure[] {
  if (committed === null) return [];
  const endpointLeaves = (body.changedLeaves as readonly string[] | undefined) ?? [];
  if (body.outcome === committed.outcome && canonical(endpointLeaves) === canonical(committed.changedLeaves)) return [];
  return [
    {
      caseId: id,
      kind: 'pipeline-disagreement',
      detail: `endpoint ${String(body.outcome)} / ${endpointLeaves.length} listů, commit vedle ${committed.outcome} / ${committed.changedLeaves.length} listů`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Rozbité prostředí: žádný verdikt, jen selhání
// ---------------------------------------------------------------------------

function transportFailure(
  id: string,
  branch: 'create' | 'edit',
  frozen: FrozenResponse,
  contract: Contract,
  detail: string,
): CaseResult {
  return {
    id,
    branch,
    declared: frozen.expectedVerdict,
    verdict: 'FAULT',
    gates: [detail],
    unmet: contract.requirements.map((requirement) => requirement.rid),
    stoppedAt: null,
    repairApplied: [],
    browserReplayed: false,
    browserHash: null,
    offlineHash: null,
    records: [],
    failures: [
      { caseId: id, kind: 'transport', detail },
      { caseId: id, kind: 'stage-missing', detail: `0 stadií místo ${STAGES.length}` },
    ],
  };
}

// ---------------------------------------------------------------------------
// Běh
// ---------------------------------------------------------------------------

export async function runOfflineChain(transport: Transport): Promise<ChainReport> {
  const contracts = new Map(loadContracts().map((contract) => [contract.id, contract]));
  const responses = frozenResponses();
  const byId = new Map(responses.map((response) => [response.forPrompt, response]));

  const cases: CaseResult[] = [];
  for (const frozen of responses) {
    const contract = contracts.get(frozen.forPrompt);
    if (contract === undefined) throw new Error(`prompt ${frozen.forPrompt} nemá zmrazený kontrakt`);

    if (frozen.branch === 'create') {
      cases.push(await runCreate(frozen, contract, transport));
      continue;
    }
    const base = byId.get(frozen.baseWorld ?? '');
    if (base === undefined) throw new Error(`${frozen.forPrompt} jmenuje základní svět, který v korpusu není`);
    cases.push(await runEdit(frozen, contract, base, transport));
  }

  const counts: Record<Verdict, number> = { FULFILLED: 0, ROBUST: 0, NO_FIT: 0, FAULT: 0 };
  for (const result of cases) counts[result.verdict] += 1;

  const threshold = frozenThreshold();
  const failures = cases.flatMap((result) => result.failures);
  const thresholdMet = counts.FULFILLED === threshold;
  if (!thresholdMet)
    failures.push({
      caseId: '*',
      kind: 'threshold',
      detail: `naměřeno ${counts.FULFILLED} FULFILLED, zmrazený protokol žádá přesně ${threshold}`,
    });

  return {
    cases,
    records: cases.flatMap((result) => result.records),
    counts,
    fulfilled: counts.FULFILLED,
    threshold,
    thresholdMet,
    browserReplays: cases.filter((result) => result.browserReplayed).length,
    failures,
    ok: failures.length === 0,
  };
}
