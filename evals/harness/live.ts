/**
 * Živý běh (T18) — skutečný modelový výstup protažený **celým** řetězcem.
 *
 * Tvarem je to dvojče `chain.ts`: pět stadií (emise → validace → oprava →
 * commit → replay), zřetězených hashem, ohodnocených sémantickým scorerem z
 * T16. Jediný rozdíl je ten, kvůli kterému celý plán existuje — **stadium
 * emise nečte zmrazený soubor, ale volá poskytovatele.**
 *
 * ## Čím je řetěz ukotvený, a proč to review v6 přepsalo
 *
 * AC T17 kotví první hash ke **zmrazené syntetické** odpovědi z manifestu.
 * Živá odpověď takový hash mít nemůže, takže původní znění T18 („splní totéž
 * AC jako T17") vedlo na dvě cesty a obě špatné: běh buď spadne, nebo — mnohem
 * hůř — sáhne po zmrazeném záznamu a vydá ho za důkaz o kvalitě modelu. To je
 * přesně ta záměna, kterou má tenhle soubor znemožnit.
 *
 * Kotva je proto **odpověď z toho konkrétního volání, uložená nezměněná na
 * disk**, a hash se počítá **ze souboru po zápisu**, ne z hodnoty v paměti.
 * Rozdíl není kosmetický: hash z paměti dokládá, co si běh myslel, že uložil;
 * hash ze souboru dokládá, co je doopravdy v `evals/live/<runId>/responses/` —
 * tedy to jediné, co půjde zpětně auditovat.
 *
 * ## Brána proti zmrazenému korpusu
 *
 * `frozenBodyHashes()` sesbírá hashe **všech** zmrazených odpovědí a živý
 * případ, jehož odpověď nebo tělo na kterýkoli z nich sedne, je selhání běhu
 * (`frozen-leak`), ne nízké skóre. Bez téhle brány by „živý" běh se zapnutým
 * záznamovým klientem vypadal úplně stejně jako skutečný — a vydal by zmrazená
 * čísla za naměřenou kvalitu modelu.
 *
 * ## Strop útraty zastavuje, neselhává
 *
 * Došlé peníze nejsou vada potrubí ani vada modelu. Běh se zastaví, `complete`
 * je `false` a report nese, na kolika případech se to stalo — výsledek je
 * **neúplný**, a tak se i vykazuje. Vydávat useknutý běh za změřenou sadu je
 * tichý podvrh na statistice, kterou z něj bude počítat T20.
 *
 * ## Co se sem záměrně nedostalo
 *
 * Endpointy. `POST /api/emit` je vázaný na zmrazený korpus (`src/model/client.ts`
 * je v P1 výhradně režim záznamu), takže živý běh jede toutéž **produkční**
 * validační cestou, kterou `chain.ts` spouští vedle endpointu — `validateEmission`,
 * `repairEmission`, `sealSimHash`, `verifyWitness`. Není to druhá implementace;
 * je to týž kód, jen jinak nakrmený. Živá editace přes `POST /api/edit` je T19.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildRuntimeWorld } from '../../src/ir/build';
import { canonical, peelEnvelope, type WorldDoc } from '../../src/ir/worlddoc';
import { frozenGrammar } from '../../src/model/client';
import { buildEmissionRequest, type UpstreamRequest } from '../../src/model/prompt';
import { repairEmission } from '../../src/patch/repair';
import { verifyWitness, type VerifiableWorld, type VerifyResult } from '../../src/verify/witness';
import { loadContracts, scoreCase, type Contract, type Evidence, type Verdict } from '../scorer/semantic';
import {
  chainFailures,
  frozenResponses,
  ledger,
  stageHash,
  validateEmission,
  type FailureKind,
  type StageRecord,
  type StopStage,
  type Transport,
} from './chain';
import {
  costUsd,
  preflight,
  withLiveModel,
  type Env,
  type LiveConfig,
  type PreflightFailure,
  type Usage,
} from './preflight';

const FROZEN_DIR = join(process.cwd(), 'evals', 'frozen');
const LIVE_DIR = join(process.cwd(), 'evals', 'live');

// ---------------------------------------------------------------------------
// Doprava k poskytovateli
// ---------------------------------------------------------------------------

export interface LiveCompletion {
  /** Odpověď poskytovatele **doslova**, jak přišla. Nic se z ní neodebírá. */
  readonly raw: unknown;
  /** Text zprávy, ze kterého se teprve loupe emise. */
  readonly text: string;
  readonly usage: Usage;
}

export interface ProviderTransport {
  readonly complete: (request: UpstreamRequest, config: LiveConfig) => Promise<LiveCompletion>;
}

/** Počet tokenů musí být konečné nezáporné číslo — jinak se strop nedá počítat. */
const isTokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Strop výstupu jednoho volání.
 *
 * Bez něj nemá jedno volání horní mez ceny a „tvrdý strop" je tvrdý jen do
 * poslední žádosti. Číslo je velkorysé vůči emisi celého světa a zároveň
 * konečné, což je celý požadavek.
 */
export const MAX_OUTPUT_TOKENS = 16_000;

/**
 * Konzervativní horní odhad ceny volání, které ještě neproběhlo.
 *
 * Vstup se odhaduje z délky zprávy dělené dvěma. Skutečná tokenizace dělá
 * zhruba 4 znaky na token, takže odhad je asi dvojnásobný — **a to je ta
 * správná strana**: přestřelený odhad zastaví běh dřív, podstřelený ho pustí
 * přes schválený strop. Výstup mez nemá odhadnutou, ale vynucenou
 * (`MAX_OUTPUT_TOKENS`).
 */
export function worstCaseCostUsd(request: UpstreamRequest, config: LiveConfig): number {
  const inputTokens = Math.ceil((request.system.length + request.user.length) / 2);
  return costUsd({ inputTokens, outputTokens: MAX_OUTPUT_TOKENS }, config);
}

/**
 * Skutečné volání OpenAI.
 *
 * `fetchImpl` se dá podstrčit, aby šla doprava otestovat bez sítě — ale
 * **výchozí je globální `fetch`**, ne double. Double jako default je přesně to,
 * čím by se dal celý živý běh nepozorovaně vypnout.
 */
export function openAiTransport(fetchImpl: typeof fetch = fetch): ProviderTransport {
  return {
    async complete(request, config) {
      const response = await fetchImpl(config.model.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          response_format: { type: 'json_object' },
          // Bez horní meze výstupu nemá jedno volání strop ceny.
          max_completion_tokens: MAX_OUTPUT_TOKENS,
        }),
      });

      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        // **Tělo chyby se do hlášky nedává.** U 401 v něm poskytovatel
        // odesílaný klíč cituje (byť maskovaný) a špatně nastavená proxy ho
        // umí vrátit celý — a tahle hláška končí v logu běhu a v CI výstupu.
        // Kód a typ stačí k diagnóze a nenesou nic tajného.
        const error = (raw as { error?: { type?: unknown; code?: unknown } } | null)?.error;
        throw new Error(
          `poskytovatel vrátil ${response.status} (type=${String(error?.type ?? 'neuveden')}, code=${String(error?.code ?? 'neuveden')})`,
        );
      }

      const choice = (raw as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0];
      const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
      const reported = (raw as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null)?.usage;

      // **Chybějící `usage` je selhání, ne nula.** `?? 0` by z neznámé útraty
      // udělal nulovou, `spentUsd` by nerostl a strop by nikdy nesepnul —
      // celá sada by se protočila bez rozpočtu. Stačí k tomu 200 s tělem,
      // které není JSON (gateway, proxy, useknutá odpověď): `raw` je pak
      // `null` a počty tokenů chybí obojí. Fail closed.
      if (!isTokenCount(reported?.prompt_tokens) || !isTokenCount(reported?.completion_tokens))
        throw new Error(
          `poskytovatel nevykázal usage (prompt=${String(reported?.prompt_tokens)}, completion=${String(reported?.completion_tokens)}); bez počtu tokenů se strop nedá vynutit`,
        );

      return { raw, text, usage: { inputTokens: reported.prompt_tokens!, outputTokens: reported.completion_tokens! } };
    },
  };
}

// ---------------------------------------------------------------------------
// Uložení odpovědi — artefakt, na kterém stojí kotva řetězu
// ---------------------------------------------------------------------------

/** Jak se z textu odpovědi dostal JSON. Vykazuje se, nenormalizuje se potichu. */
export type ParsedVia = 'direct' | 'fence' | 'unparseable';

export interface LiveRecord {
  /** Protiklad `synthetic: true` ze zmrazeného korpusu. Je to celý rozdíl. */
  readonly synthetic: false;
  readonly runId: string;
  readonly forPrompt: string;
  readonly branch: 'create';
  /** Požadavek, který doopravdy odešel. **Bez klíče** — ten se nikam neukládá. */
  readonly request: UpstreamRequest;
  readonly raw: unknown;
  readonly body: unknown;
  readonly parsedVia: ParsedVia;
  readonly usage: Usage;
  readonly costUsd: number;
}

/**
 * Vyloupne JSON z textu odpovědi.
 *
 * Systémová zpráva žádá „a single JSON object and nothing else", takže obalení
 * do ```json fence je odchylka. **Toleruje se a vykazuje se** (`parsedVia`):
 * je to artefakt formátu, ne sémantická vada světa, ale zamlčet ho by znamenalo
 * měřit něco jiného, než co model poslal. Uložený `raw` zůstává nedotčený tak
 * jako tak.
 */
export function extractJson(text: string): { readonly body: unknown; readonly via: ParsedVia } {
  try {
    return { body: JSON.parse(text), via: 'direct' };
  } catch {
    // fence
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced !== null)
    try {
      return { body: JSON.parse(fenced[1]), via: 'fence' };
    } catch {
      // spadne níž
    }
  return { body: text, via: 'unparseable' };
}

export function responsesDir(runId: string, root: string = LIVE_DIR): string {
  return join(root, runId, 'responses');
}

/**
 * Zapíše záznam a **přečte ho zpátky**.
 *
 * Vrací hash spočítaný z toho, co je na disku. Kdyby se počítal z hodnoty v
 * paměti, doložil by úmysl, ne artefakt — a auditovatelnost celého běhu stojí
 * právě na tom souboru.
 */
export function storeResponse(record: LiveRecord, root: string = LIVE_DIR): { readonly path: string; readonly rawHash: string; readonly bodyHash: string } {
  const dir = responsesDir(record.runId, root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.forPrompt}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  const reread = JSON.parse(readFileSync(path, 'utf8')) as LiveRecord;
  return { path, rawHash: stageHash(reread.raw), bodyHash: stageHash(reread.body) };
}

// ---------------------------------------------------------------------------
// Vstupy a brány
// ---------------------------------------------------------------------------

export interface LivePrompt {
  readonly id: string;
  readonly kind: string;
  readonly prompt: string;
}

export function createPrompts(): readonly LivePrompt[] {
  return readFileSync(join(FROZEN_DIR, 'prompts.v1.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as LivePrompt)
    .filter((entry) => entry.kind === 'create');
}

/**
 * Hashe **všech** zmrazených odpovědí — deklarované v manifestu i dopočítané.
 *
 * Obojí, protože každý chytá jinou cestu: `sha256` ze záznamu chytne odpověď
 * podstrčenou i s hlavičkou, dopočítaný hash chytne samotné tělo přenesené jinam.
 */
export function frozenBodyHashes(): ReadonlySet<string> {
  const hashes = new Set<string>();
  for (const response of frozenResponses()) {
    hashes.add(response.sha256);
    hashes.add(stageHash(response.body));
    hashes.add(canonicalHash(response.body));
  }
  return hashes;
}

/**
 * Hash nad **kanonickým** tvarem, tedy s seřazenými klíči.
 *
 * `stageHash` jede přes `JSON.stringify` a ten je citlivý na pořadí klíčů,
 * takže zmrazené tělo protažené čímkoli, co objekty přeskládá (parser podle
 * schématu, `canonical()` samotné), by dalo jiný hash a branou by prošlo —
 * přestože je významově bajt po bajtu totéž. Obě formy proto jdou do sady i do
 * porovnání.
 */
export function canonicalHash(value: unknown): string {
  try {
    return createHash('sha256').update(canonical(value)).digest('hex');
  } catch {
    // Nekanonizovatelný vstup (model vrátil text) — `stageHash` ho pokrývá.
    return stageHash(value);
  }
}

// ---------------------------------------------------------------------------
// Selhání
// ---------------------------------------------------------------------------

export type LiveFailureKind =
  | FailureKind
  /** Živý případ ukazuje na hash ze zmrazeného korpusu. */
  | 'frozen-leak'
  /** Poskytovatel volání neodbavil — rozbité prostředí, ne naměřený výsledek. */
  | 'provider';

export interface LiveFailure {
  readonly caseId: string;
  readonly kind: LiveFailureKind;
  readonly detail: string;
}

export interface LiveCaseResult {
  readonly id: string;
  readonly verdict: Verdict;
  readonly gates: readonly string[];
  readonly unmet: readonly string[];
  readonly stoppedAt: StopStage;
  readonly parsedVia: ParsedVia;
  readonly repairApplied: readonly string[];
  readonly browserReplayed: boolean;
  readonly browserHash: string | null;
  readonly offlineHash: string | null;
  /** Kotva řetězu: hash **nezměněné** odpovědi, přečtený ze souboru. */
  readonly rawHash: string;
  readonly bodyHash: string;
  readonly responsePath: string;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly records: readonly StageRecord[];
  readonly failures: readonly LiveFailure[];
}

export interface LiveReport {
  readonly runId: string;
  readonly model: string;
  readonly cases: readonly LiveCaseResult[];
  readonly records: readonly StageRecord[];
  readonly counts: Readonly<Record<Verdict, number>>;
  readonly fulfilled: number;
  /** Kolik promptů se odbavilo z kolika, která sada čítá. */
  readonly attempted: number;
  readonly total: number;
  /** `false` = běh se zastavil na stropu a výsledek je NEÚPLNÝ. */
  readonly complete: boolean;
  readonly stoppedReason: string | null;
  readonly spentUsd: number;
  readonly capUsd: number;
  readonly browserReplays: number;
  readonly responsesDir: string;
  readonly failures: readonly LiveFailure[];
  readonly ok: boolean;
}

// ---------------------------------------------------------------------------
// Jeden případ
// ---------------------------------------------------------------------------

const hashOf = (result: VerifyResult | null): string | null =>
  result !== null && result.verdict === 'CERTIFIED' ? result.snapshotHash : null;

async function runLiveCreate(
  prompt: LivePrompt,
  contract: Contract,
  request: UpstreamRequest,
  completion: LiveCompletion,
  config: LiveConfig,
  runId: string,
  replay: Transport['replay'],
  frozenHashes: ReadonlySet<string>,
  root: string,
): Promise<LiveCaseResult> {
  const id = prompt.id;
  const failures: LiveFailure[] = [];
  const { body, via } = extractJson(completion.text);
  const spent = costUsd(completion.usage, config);

  const stored = storeResponse(
    {
      synthetic: false,
      runId,
      forPrompt: id,
      branch: 'create',
      // Týž objekt, který odešel k poskytovateli — ne druhá konstrukce téhož.
      request,
      raw: completion.raw,
      body,
      parsedVia: via,
      usage: completion.usage,
      costUsd: spent,
    },
    root,
  );

  // Brána: živý případ nesmí ukazovat na nic ze zmrazeného korpusu.
  for (const [what, hash] of [
    ['odpověď', stored.rawHash],
    ['tělo', stored.bodyHash],
    ['tělo v kanonickém tvaru', canonicalHash(body)],
  ] as const)
    if (frozenHashes.has(hash))
      failures.push({
        caseId: id,
        kind: 'frozen-leak',
        detail: `${what} živého případu má hash ${hash}, který je ve zmrazeném korpusu — běh čte záznam, ne poskytovatele`,
      });

  const requestId = randomUUID();
  const log = ledger(id, requestId, stored.rawHash);

  // 1 — emise: co model poslal, oloupané od obálkových anotací. Dokument a jeho
  // anotace jedou od téhle chvíle zvlášť — přesně jako u endpointu, protože
  // `simOutcome: "NO_FIT"` v oloupaném dokumentu nezůstane.
  const peeled = peelEnvelope(body);
  const emission = peeled?.document ?? body;
  const annotations = peeled?.annotations ?? {};
  log.write('emit', { emission, annotations, parsedVia: via }, `${config.model.id}, ${via}`);

  // 2 — validace: týž produkční řetěz jako v `chain.ts`
  const validation = validateEmission(emission, annotations);
  log.write(
    'validate',
    { ok: validation.ok, stage: validation.stage, reason: validation.reason, detail: validation.detail },
    validation.ok ? `prošlo (${validation.reason})` : `${String(validation.stage)}/${validation.reason}`,
  );

  // 3 — oprava, jen když validace odmítla
  let effective = validation;
  let repairApplied: readonly string[] = [];
  if (validation.ok) {
    log.identity('repair', 'validace prošla, mechanická oprava se nespouští');
  } else {
    const repaired = repairEmission(emission);
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
  const committed: WorldDoc | null = effective.doc;
  log.write(
    'commit',
    committed ?? { committed: false, reason: `${String(effective.stage)}/${effective.reason}` },
    committed === null ? `necommitnuto: ${String(effective.stage)}/${effective.reason}` : `zapečetěno simHash ${committed.simHash}`,
  );

  // 5 — replay v prohlížeči
  const world: VerifiableWorld | null = effective.world;
  const offline = world === null ? null : verifyWitness(world, world.trace);
  const browser = world === null ? null : await replay(world, world.trace);
  if (browser !== null && offline !== null && canonical(browser) !== canonical(offline))
    failures.push({
      caseId: id,
      kind: 'browser-divergence',
      detail: `prohlížeč ${canonical(browser).slice(0, 160)}, Node ${canonical(offline).slice(0, 160)}`,
    });
  log.write(
    'replay',
    browser ?? { replayed: false, reason: `${String(effective.stage)}: svět se nepostavil` },
    browser === null ? 'svět se nepostavil, není co přehrát' : `prohlížeč: ${browser.verdict}`,
  );

  // Konvence T16: `declined` jedině u deklarovaného `NO_FIT`.
  const evidence: Evidence =
    effective.stage === 'declined'
      ? { kind: 'create', outcome: 'declined', sceneBuilt: effective.sceneBuilt }
      : { kind: 'create', outcome: 'emitted', doc: emission, sceneBuilt: effective.sceneBuilt };

  const score = scoreCase(contract, evidence);
  failures.push(...chainFailures(id, log.records, stored.rawHash));

  return {
    id,
    verdict: score.verdict,
    gates: score.gates,
    unmet: score.requirements.filter((requirement) => !requirement.met).map((requirement) => requirement.rid),
    stoppedAt: effective.stage === 'declined' ? null : effective.stage,
    parsedVia: via,
    repairApplied,
    browserReplayed: browser !== null,
    browserHash: hashOf(browser),
    offlineHash: hashOf(offline),
    rawHash: stored.rawHash,
    bodyHash: stored.bodyHash,
    responsePath: stored.path,
    usage: completion.usage,
    costUsd: spent,
    records: log.records,
    failures,
  };
}

/** Gramatika se čte jednou; nečitelný zmrazený protokol je rozbité prostředí. */
let grammarCache: ReturnType<typeof frozenGrammar> | null = null;
function grammar(): Parameters<typeof buildEmissionRequest>[1] {
  grammarCache ??= frozenGrammar();
  if (!grammarCache.ok) throw new Error(`zmrazený protokol nejde přečíst: ${grammarCache.detail}`);
  return grammarCache.value;
}

// ---------------------------------------------------------------------------
// Běh
// ---------------------------------------------------------------------------

export interface LiveOptions {
  readonly env: Env;
  readonly provider: ProviderTransport;
  readonly replay: Transport['replay'];
  /** Vlastní id běhu. Bez něj se vygeneruje — do jména adresáře na disku. */
  readonly runId?: string;
  /** Podmnožina promptů. Bez ní jede celá create sada. */
  readonly promptIds?: readonly string[];
  /** Kořen pro `evals/live/`. Testy si ho přesměrují mimo repozitář. */
  readonly root?: string;
}

/**
 * Preflight selhal ještě před prvním voláním — nic se neutratilo a nic se
 * nezměřilo. Vrací se jako výjimka schválně: prázdný report by se dal splést
 * s během, ve kterém model na všem selhal.
 */
export class PreflightError extends Error {
  constructor(readonly failure: PreflightFailure) {
    super(`preflight selhal (${failure.reason}): ${failure.detail}`);
    this.name = 'PreflightError';
  }
}

export async function runLiveChain(options: LiveOptions): Promise<LiveReport> {
  const root = options.root ?? LIVE_DIR;
  const runId = options.runId ?? randomUUID();

  // PŘED prvním placeným voláním. Selhání tady je odmítnutí startu, ne výsledek.
  const initial = preflight(options.env, 0);
  if (!initial.ok) throw new PreflightError(initial);

  const contracts = new Map(loadContracts().map((contract) => [contract.id, contract]));
  const frozenHashes = frozenBodyHashes();
  const all = createPrompts();
  const prompts = options.promptIds === undefined ? all : all.filter((entry) => options.promptIds!.includes(entry.id));

  const cases: LiveCaseResult[] = [];
  const failures: LiveFailure[] = [];
  let spentUsd = 0;
  let stoppedReason: string | null = null;

  for (const prompt of prompts) {
    // Strop se kontroluje PŘED každým dalším voláním, ne po něm.
    const gate = preflight(options.env, spentUsd);
    if (!gate.ok) {
      stoppedReason = `${gate.reason}: ${gate.detail}`;
      break;
    }

    const contract = contracts.get(prompt.id);
    if (contract === undefined) throw new Error(`prompt ${prompt.id} nemá zmrazený kontrakt`);

    // Požadavek se staví **jednou**: týž objekt odejde k poskytovateli a týž se
    // uloží do artefaktu. Druhá konstrukce by artefakt s voláním nespojila —
    // záznam by tvrdil, co se poslat mělo, ne co se poslalo.
    const request = withLiveModel(buildEmissionRequest(prompt.prompt, grammar()), gate);

    // **Tvrdý strop rezervuje nejhorší cenu volání, ne nulovou.** Pustit
    // volání jen proto, že do stropu ještě něco zbývá, znamená překročit ho
    // o celé jedno volání — schválená částka je pak horní mez jen přibližně.
    const reserve = worstCaseCostUsd(request, gate);
    if (reserve > gate.remainingUsd) {
      stoppedReason = `CAP_RESERVE: zbývá ${gate.remainingUsd.toFixed(5)} USD, ale volání může stát až ${reserve.toFixed(5)} USD`;
      break;
    }

    let completion: LiveCompletion;
    try {
      completion = await options.provider.complete(request, gate);
      // Platí pro KAŽDOU dopravu, ne jen pro tu naši: nepoužitelné `usage`
      // znamená neznámou útratu, a ta se nesmí započítat jako nulová.
      if (!isTokenCount(completion.usage.inputTokens) || !isTokenCount(completion.usage.outputTokens))
        throw new Error(
          `doprava vrátila nepoužitelné usage (in=${String(completion.usage.inputTokens)}, out=${String(completion.usage.outputTokens)})`,
        );
    } catch (thrown) {
      failures.push({ caseId: prompt.id, kind: 'provider', detail: (thrown as Error).message });
      // **Neznámá útrata zastavuje běh, a účtuje se jako nejhorší možná.**
      // Volání, které se nepovedlo přečíst, poskytovatel účtovat mohl —
      // pokračovat by znamenalo volat dál s cenou, kterou nikdo nesčítá, a
      // strop by nesepnul ani po patnácti takových. Zastavit a přiznat
      // neúplnost je jediná bezpečná strana: přeceněná rezerva stojí jeden
      // zbytečně useknutý běh, podceněná stojí peníze.
      spentUsd += reserve;
      stoppedReason = `PROVIDER_UNUSABLE: ${prompt.id} — útrata volání je neznámá, rezerva ${reserve.toFixed(5)} USD účtována`;
      break;
    }

    const result = await runLiveCreate(prompt, contract, request, completion, gate, runId, options.replay, frozenHashes, root);
    spentUsd += result.costUsd;
    cases.push(result);
    failures.push(...result.failures);
  }

  // Neúplný běh musí vždycky umět říct proč. Bez tohohle řádku vyjde po
  // spadlém volání `complete: false` se `stoppedReason: null` — report, který
  // si protiřečí, a čtenář hledá chybu ve stropu, kde žádná není.
  if (stoppedReason === null && cases.length !== prompts.length)
    stoppedReason = `PROVIDER_FAILURES: ${prompts.length - cases.length} z ${prompts.length} promptů se neodbavilo`;

  const counts: Record<Verdict, number> = { FULFILLED: 0, ROBUST: 0, NO_FIT: 0, FAULT: 0 };
  for (const result of cases) counts[result.verdict] += 1;

  return {
    runId,
    model: initial.model.id,
    cases,
    records: cases.flatMap((result) => result.records),
    counts,
    fulfilled: counts.FULFILLED,
    attempted: cases.length,
    total: prompts.length,
    // Prázdná sada není úplný běh. `promptIds` s překlepem dá `total: 0`, a
    // bez téhle podmínky by se vykázal jako `complete: true` — tedy jako
    // hotové měření, které nezměřilo nic.
    complete: stoppedReason === null && prompts.length > 0 && cases.length === prompts.length,
    stoppedReason,
    spentUsd,
    capUsd: initial.capUsd,
    browserReplays: cases.filter((result) => result.browserReplayed).length,
    responsesDir: responsesDir(runId, root),
    failures,
    // Běh, který nezměřil nic, není běh v pořádku. Bez `attempted > 0` vyjde
    // `ok: true` i tam, kde se neodbavil ani jeden prompt — a to je přesně
    // ten signál, který by T20 vzal jako platnou sadu.
    ok: failures.length === 0 && cases.length > 0,
  };
}
