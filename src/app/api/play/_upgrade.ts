/**
 * Progresivní hra (P23-D T2): návrh ze slov se publikuje hned, režisér běží
 * na pozadí a jeho autorská verze se publikuje jako dítě návrhu
 * (`parentId = draftId`, `relation: 'upgrade'`).
 *
 * Práce v letu drží mapa na `globalThis` – routy `POST /api/play/games`
 * a `GET …/:id/upgrade` jsou v Next.js oddělené moduly a modulová proměnná by
 * každá měla svou. Mapa žije jen v procesu (`next start`); na serverless nebo
 * po restartu ji nikdo nemá a práci spustí až dotaz na `…/upgrade`.
 * **Hotové dítě se proto hledá nejdřív v úložišti**: kdo ho už publikoval,
 * nezaplatí model podruhé.
 *
 * Slib práce nikdy neodmítne – každá chyba je `draft-final` s důvodem, aby
 * neodchycená výjimka na pozadí neshodila proces.
 *
 * AI verze se nabídne vždy, když projde ověřením (P38, ruší bránu P37A T8):
 * kontrolní seznam věty počítá jen jména a slovesa, ne jak se hra hraje, takže
 * o přepnutí rozhodne hráč přepínačem Quick | AI (`UpgradeBanner.tsx`).
 *
 * Podtržítko v názvu: Next.js soubor nebere jako route.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { after } from 'next/server';

import { type GameSpecV1, gameSpecHash, readGameSpec } from '@/play/spec';
import { actionEvidence, lostActions } from '@/play/fidelity/action-evidence';
import { extractIntent } from '@/play/intent/extract';
import { type PublishedGame, type VersionStore, VersionStoreUnavailable } from '@/play/version';

import { DIRECTOR_BUDGET_MS, getDirector } from './_director';
import { derivedSeeds, playabilityIssues, publishReadSpec, seedFrom } from './_publish';

export type DraftFinalReason =
  | 'MODEL_UNAVAILABLE'
  | 'MALFORMED'
  | 'UNREPAIRED'
  | 'VERB_UNPROVED'
  | 'ACTION_LOST'
  | 'UNCHANGED'
  | 'NOT_PLAYABLE'
  | 'STORE_UNAVAILABLE'
  | 'NOT_FROM_SENTENCE'
  /** Text AI verze trefil zakázané téma (P40 T2) – do feedu nejde, rychlá verze zůstane. */
  | 'BLOCKED'
  | 'FAILED';

export type UpgradeOutcome =
  | { readonly status: 'ready'; readonly versionId: string }
  | { readonly status: 'draft-final'; readonly reason: DraftFinalReason };

/** `deadlineAt` (ISO): do kdy se má klient ptát – start práce + rozpočet režie + rezerva (P27C T1). */
export type UpgradeStatus = UpgradeOutcome | { readonly status: 'pending'; readonly deadlineAt: string };

/**
 * Rezerva nad rozpočtem režie: kompilace, zápis dítěte a zpoždění dotazu.
 * Klient se po `deadlineAt` bez výsledku přestane ptát a řekne, že AI ztratil.
 */
export const UPGRADE_DEADLINE_SLACK_MS = 15_000;

/** `pending` práce, která začala `startedAt` (`Date.now()` příchodu požadavku). */
export function pendingSince(startedAt: number): UpgradeStatus {
  return { status: 'pending', deadlineAt: new Date(startedAt + DIRECTOR_BUDGET_MS + UPGRADE_DEADLINE_SLACK_MS).toISOString() };
}

/** Co zná POST a dotaz na upgrade ne: věta, semínko volajícího a dva první časy vodopádu. */
export interface UpgradeRequest {
  readonly sentence: string;
  readonly seed: number | null;
  readonly ackMs: number | null;
  readonly draftReadyMs: number | null;
  /** Příchod požadavku, v jehož `after()` práce běží (`Date.now()`); od něj se měří rozpočet režie (R7). */
  readonly startedAt: number;
  /** Komu se placené volání započte (R8) – autor věty, nebo divák, jehož dotaz práci spustil. */
  readonly caller: string;
}

interface Job {
  readonly done: Promise<UpgradeOutcome>;
  readonly startedAt: number;
  outcome: UpgradeOutcome | null;
}

/**
 * Kolik prací si proces pamatuje. Nad tím zapomene nejstarší **doběhlou** –
 * běžící zůstává, jinak by druhý dotaz spustil druhou placenou režii.
 * Zapomenutá práce se z úložiště dohledá jako `ready` i `draft-final` (R10).
 */
export const MAX_REMEMBERED_UPGRADES = 1000;

const JOBS = Symbol.for('worldstream.play.upgrades');

function jobs(): Map<string, Job> {
  const holder = globalThis as { [JOBS]?: Map<string, Job> };
  holder[JOBS] ??= new Map();
  return holder[JOBS];
}

/** Jen pro testy. */
export function __resetUpgrades(): void {
  jobs().clear();
}

function forgetSettled(map: Map<string, Job>): void {
  for (const [id, job] of map) {
    if (map.size <= MAX_REMEMBERED_UPGRADES) return;
    if (job.outcome !== null) map.delete(id);
  }
}

/** Dítě návrhu, které už je autorskou verzí – z úložiště, ne z paměti procesu. */
async function publishedUpgrade(versions: VersionStore, draft: PublishedGame, sentence: string): Promise<string | null> {
  const draftId = draft.version.versionId;
  const intent = extractIntent(sentence);
  let before: Awaited<ReturnType<typeof actionEvidence>> | undefined;
  for (const childId of await versions.childrenOf(draftId)) {
    const child = await versions.get(childId);
    if (child?.relation !== 'upgrade' || child.version.parentId !== draftId) continue;
    before ??= await actionEvidence(draft.spec, draft.version.seed, draft.arcade);
    const after = await actionEvidence(child.spec, child.version.seed, child.arcade);
    if (lostActions(intent, before, after).length === 0) return childId;
  }
  return null;
}

const REFUSAL_REASON: Readonly<Record<number, DraftFinalReason>> = { 422: 'NOT_PLAYABLE', 503: 'STORE_UNAVAILABLE' };

/**
 * Jak dlouho platí uložený `draft-final` (R10). Mapa v paměti procesu nepřežije
 * restart, jinou instanci ani vytlačení, a návrh z věty polluje každý divák
 * sdíleného odkazu – bez záznamu v úložišti by každý z nich zaplatil novou
 * režii. Hodina místo navždy.
 */
export const DRAFT_FINAL_TTL_SECONDS = 3600;

/**
 * Pamatuje se (v úložišti i v paměti procesu) jen verdikt **o větě**: model
 * odpověděl a výsledek se nedá použít. Výpadek modelu, plné sloty, vypínač,
 * strop utrácení, vyčerpaný počet volajícího nebo úložiště o větě neříkají
 * nic – uložené by na hodinu zmrazily cizí návrh a útočník by to uměl
 * vyvolat zdarma (revize R10). Další dotaz pak dostane nový pokus.
 */
const SENTENCE_VERDICTS: ReadonlySet<DraftFinalReason> = new Set(['MALFORMED', 'UNREPAIRED', 'VERB_UNPROVED', 'ACTION_LOST', 'UNCHANGED', 'NOT_PLAYABLE', 'BLOCKED']);

export function isTransient(outcome: UpgradeOutcome): boolean {
  return outcome.status === 'draft-final' && !SENTENCE_VERDICTS.has(outcome.reason);
}

async function runUpgrade(versions: VersionStore, draft: PublishedGame, request: UpgradeRequest): Promise<UpgradeOutcome> {
  const draftId = draft.version.versionId;
  const existing = await publishedUpgrade(versions, draft, request.sentence);
  if (existing !== null) return { status: 'ready', versionId: existing };
  // Čte se jen verdikt o větě: záznam z buildu před revizí R10 (nebo z jiného
  // nasazení nad týmž prefixem) může nést přechodný důvod.
  const remembered = await versions.upgradeVerdict(draftId);
  if (remembered !== null && SENTENCE_VERDICTS.has(remembered as DraftFinalReason)) return { status: 'draft-final', reason: remembered as DraftFinalReason };

  const outcome = await directUpgrade(versions, draft, request);
  if (outcome.status === 'draft-final' && !isTransient(outcome)) await versions.rememberUpgradeVerdict(draftId, outcome.reason, DRAFT_FINAL_TTL_SECONDS);
  return outcome;
}

/** Proč vylepšení skončilo návrhem: fáze, přesný důvod a co model nebo kompilátor dostal. */
export interface UpgradeFailure {
  readonly stage: 'model' | 'read' | 'critic' | 'upgrade' | 'publish';
  readonly reason: string;
  readonly detail: string;
  readonly raw: unknown;
}

/**
 * Řádek konce neúspěšného pokusu. Srovnání modelů (`scripts/play-fidelity.mjs
 * --models`) z něj čte příčinu: plné dveře, strop, nebo model.
 */
export function upgradeEndedLine(draftId: string, reason: DraftFinalReason, failure: Pick<UpgradeFailure, 'stage' | 'reason' | 'detail'>): string {
  return `[play] upgrade of ${draftId} ended ${reason} at ${failure.stage}: ${failure.reason} – ${failure.detail.slice(0, 300)}`;
}

/**
 * Začátek a konec každého pokusu (P30A T7b). Srovnání modelů podle nich čeká,
 * až pokus věty doběhne, než pustí další větu – visící pokus by držel slot dveří
 * a další věta by dostala návrh od dveří. Oba jdou přes `console.warn` jako
 * řádek `ended`: v jednom proudu ho konec nikdy nepředběhne.
 */
export function upgradeAttemptLine(draftId: string, phase: 'started' | 'settled'): string {
  return `[play] upgrade attempt ${phase} ${draftId}`;
}

/**
 * Záznam selhání (P26 T3): řádek logu vždy, soubor
 * `data/play/failures/<draftId>.json` jen mimo Vercel – tam je souborový
 * systém jen pro čtení. Bez záznamu se nedá říct, proč model za 40 s
 * nic nedodal, a tři nejčastější příčiny nejdou seřadit.
 */
export function recordUpgradeFailure(draftId: string, sentence: string, reason: DraftFinalReason, failure: UpgradeFailure, env: Record<string, string | undefined> = process.env): void {
  console.warn(upgradeEndedLine(draftId, reason, failure));
  // Testy zapisují jen do složky, kterou samy určí – jinak by jejich podvržená
  // selhání přimíchaly do záznamů, ze kterých sada věrnosti počítá příčiny.
  if (env.VERCEL !== undefined || (env.VITEST !== undefined && env.PLAY_FAILURES_DIR === undefined)) return;
  const dir = env.PLAY_FAILURES_DIR ?? join(process.cwd(), 'data', 'play', 'failures');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${draftId}.json`), `${JSON.stringify({ draftId, sentence, outcome: reason, ...failure, at: new Date().toISOString() }, null, 1)}\n`);
  } catch (thrown) {
    console.warn(`[play] failure record for ${draftId} not written: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }
}

/** `director` mimo produkt jen pro měřidlo P46E (`evals/play/p46e/upgrade.ts`): nahraná odpověď místo živé větve. */
export async function directUpgrade(versions: VersionStore, draft: PublishedGame, request: UpgradeRequest, director: typeof getDirector = getDirector): Promise<UpgradeOutcome> {
  const draftId = draft.version.versionId;
  const final = (reason: DraftFinalReason, failure?: UpgradeFailure): UpgradeOutcome => {
    if (failure !== undefined) recordUpgradeFailure(draftId, request.sentence, reason, failure);
    return { status: 'draft-final', reason };
  };

  // Výpadek úložiště dřív, než se zaplatí model. Vyčerpaná kvóta ne – dítě se
  // do ní nepočítá (R11), takže odpověď `canPublish` tu nerozhoduje.
  try {
    await versions.canPublish();
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return final('STORE_UNAVAILABLE');
    throw thrown;
  }

  const seeds = request.seed !== null ? [request.seed] : derivedSeeds(seedFrom(request.sentence.trim()));
  const directorStarted = performance.now();
  // Neprošlý keypoint jde modelu k opravě dřív, než publikace hru odmítne (P26 T10a).
  const directed = await director(request.startedAt, request.caller, (spec) => playabilityIssues(spec, seeds))(request.sentence);
  const directorMs = performance.now() - directorStarted;
  if (directed.source === 'draft') return final(directed.fallbackReason ?? 'MODEL_UNAVAILABLE', directed.failure);
  if (gameSpecHash(directed.spec) === gameSpecHash(draft.spec)) return final('UNCHANGED', { stage: 'upgrade', reason: 'UNCHANGED', detail: 'the model returned the draft', raw: directed.spec });
  // Ovládání smí AI vyměnit (P26 T4, ruší R1 z P25A): návrh ze slov žánr jen
  // odhaduje a nová hra projde tímtéž ověřením robotem jako každá jiná.

  const intent = extractIntent(request.sentence);
  const before = await actionEvidence(draft.spec, draft.version.seed, draft.arcade);
  const preserving = async (spec: GameSpecV1): Promise<number[]> => {
    const kept: number[] = [];
    for (const seed of seeds) if (lostActions(intent, before, await actionEvidence(spec, seed)).length === 0) kept.push(seed);
    return kept;
  };
  let upgraded = directed.spec;
  let preservingSeeds = await preserving(upgraded);
  if (preservingSeeds.length === 0) {
    // Režisér často vybere jiný žánr a akci z věty ztratí (demo 12. 10.: 12 z 22 nahraných odpovědí).
    // Druhý pokus: hra rychlé verze s pravidly, logikou a vzhledem od režiséra (9 z 12 pak projde).
    const grafted = onQuickGame(draft.spec, directed.spec);
    if (grafted !== null && gameSpecHash(grafted) !== gameSpecHash(draft.spec) && playabilityIssues(grafted, seeds).length === 0) {
      const kept = await preserving(grafted);
      if (kept.length > 0) [upgraded, preservingSeeds] = [grafted, kept];
    }
  }
  if (preservingSeeds.length === 0) return final('ACTION_LOST', { stage: 'upgrade', reason: 'ACTION_LOST', detail: 'No candidate seed preserves all essential actions witnessed in the published quick version.', raw: directed.spec });

  const published = await publishReadSpec(versions, upgraded, preservingSeeds, draftId, {
    relation: 'upgrade',
    timings: { ackMs: request.ackMs, draftReadyMs: request.draftReadyMs, directorMs, source: directed.source },
  });
  if (!published.ok) {
    const reason = published.issues?.[0] === 'CONTENT_REJECTED' ? 'BLOCKED' : (REFUSAL_REASON[published.response.status] ?? 'FAILED');
    return final(reason, { stage: 'publish', reason: published.issues?.[0] ?? String(published.response.status), detail: (published.issues ?? []).slice(1).join('; '), raw: upgraded });
  }
  return { status: 'ready', versionId: published.value.game.version.versionId };
}

/**
 * Hra rychlé verze (žánr, ovládání, mechaniky), na které leží název, téma a nové role od
 * režiséra; jeho pravidla s věcmi a logikou nahradí ta z rychlé verze, jen když nějaká napsal.
 * `null` = výsledek `readGameSpec` odmítne.
 */
export function onQuickGame(quick: GameSpecV1, ai: GameSpecV1): GameSpecV1 | null {
  const { rules: _rules, things: _things, logic: _logic, ...base } = quick;
  const own = (ai.rules?.length ?? 0) > 0 ? ai : quick;
  const ids = new Set(quick.roles.map((role) => role.id));
  const candidate = {
    ...base,
    title: ai.title,
    theme: ai.theme,
    roles: [...quick.roles, ...ai.roles.filter((role) => !ids.has(role.id) && role.kind !== 'player')],
    ...(own.rules === undefined ? {} : { rules: own.rules }),
    ...(own.things === undefined ? {} : { things: own.things }),
    ...(own.logic === undefined ? {} : { logic: own.logic }),
  };
  const read = readGameSpec(candidate);
  return read.ok ? read.value : null;
}

/**
 * Práce pro návrh: běžící nebo doběhlá z paměti, jinak nová. Kontrola
 * a zápis do mapy jsou v jednom synchronním kroku, takže dva souběžné dotazy
 * na týž návrh spustí režiséra jednou.
 */
export function upgradeOf(versions: VersionStore, draft: PublishedGame, request: UpgradeRequest): Promise<UpgradeStatus> {
  const map = jobs();
  const draftId = draft.version.versionId;
  const known = map.get(draftId);
  // Přechodný výsledek patří jen tomu, čí dotaz práci spustil (R13): připojený
  // divák by na `draft-final` přestal pollovat, ač jeho vlastní pokus by běžel.
  if (known !== undefined) return known.done.then((outcome) => (isTransient(outcome) ? pendingSince(known.startedAt) : outcome));

  console.warn(upgradeAttemptLine(draftId, 'started'));
  const attempt = runUpgrade(versions, draft, request).catch((thrown: unknown): UpgradeOutcome => {
    console.error(`[play] upgrade of ${draftId} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    return { status: 'draft-final', reason: 'FAILED' };
  });
  const job: Job = { done: attempt, startedAt: request.startedAt, outcome: null };
  const remembered = attempt.then((outcome) => {
    console.warn(upgradeAttemptLine(draftId, 'settled'));
    if (isTransient(outcome)) {
      if (map.get(draftId) === job) map.delete(draftId);
      return;
    }
    job.outcome = outcome;
    forgetSettled(map);
  });
  map.set(draftId, job);
  // **`after()`, ne holé `void`** (revize T2): na serverless se instance po
  // odpovědi zmrazí a rezervace stropu by zůstala nevyrovnaná – tentýž důvod
  // jako u generace v `worldstream/sessions/route.ts`. Mimo request scope
  // (test volá handler přímo) `after()` vyhodí a práce doběhne sama, protože
  // se tam proces nezmrazí; pod `next start` i na Vercelu scope je.
  try {
    after(remembered);
  } catch {
    // Pod `next start` i na Vercelu se sem nedojde; kdyby ano, práce běží bez
    // záruky doběhnutí a rezervace stropu může zůstat nevyrovnaná (R7).
    console.warn(`[play] after() unavailable, upgrade of ${draftId} runs unguarded`);
    void remembered;
  }
  return job.done;
}

/** Stav bez čekání: `null` = proces o návrhu neví. */
export function knownUpgrade(draftId: string): UpgradeStatus | null {
  const job = jobs().get(draftId);
  if (job === undefined) return null;
  return job.outcome ?? pendingSince(job.startedAt);
}
