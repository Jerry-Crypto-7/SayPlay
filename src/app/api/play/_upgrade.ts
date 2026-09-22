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
 * Podtržítko v názvu: Next.js soubor nebere jako route.
 */

import { after } from 'next/server';

import { gameSpecHash } from '@/play/spec';
import { type PublishedGame, type VersionStore, VersionStoreUnavailable } from '@/play/version';

import { getDirector } from './_director';
import { derivedSeeds, publishReadSpec, seedFrom } from './_publish';

export type DraftFinalReason =
  | 'MODEL_UNAVAILABLE'
  | 'MALFORMED'
  | 'UNREPAIRED'
  | 'UNCHANGED'
  | 'NOT_PLAYABLE'
  | 'STORE_UNAVAILABLE'
  | 'NOT_FROM_SENTENCE'
  | 'FAILED';

export type UpgradeOutcome =
  | { readonly status: 'ready'; readonly versionId: string }
  | { readonly status: 'draft-final'; readonly reason: DraftFinalReason };

export type UpgradeStatus = UpgradeOutcome | { readonly status: 'pending' };

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
async function publishedUpgrade(versions: VersionStore, draftId: string): Promise<string | null> {
  for (const childId of await versions.childrenOf(draftId)) {
    const child = await versions.get(childId);
    if (child?.relation === 'upgrade' && child.version.parentId === draftId) return childId;
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
const SENTENCE_VERDICTS: ReadonlySet<DraftFinalReason> = new Set(['MALFORMED', 'UNREPAIRED', 'UNCHANGED', 'NOT_PLAYABLE']);

function isTransient(outcome: UpgradeOutcome): boolean {
  return outcome.status === 'draft-final' && !SENTENCE_VERDICTS.has(outcome.reason);
}

async function runUpgrade(versions: VersionStore, draft: PublishedGame, request: UpgradeRequest): Promise<UpgradeOutcome> {
  const draftId = draft.version.versionId;
  const existing = await publishedUpgrade(versions, draftId);
  if (existing !== null) return { status: 'ready', versionId: existing };
  // Čte se jen verdikt o větě: záznam z buildu před revizí R10 (nebo z jiného
  // nasazení nad týmž prefixem) může nést přechodný důvod.
  const remembered = await versions.upgradeVerdict(draftId);
  if (remembered !== null && SENTENCE_VERDICTS.has(remembered as DraftFinalReason)) return { status: 'draft-final', reason: remembered as DraftFinalReason };

  const outcome = await directUpgrade(versions, draft, request);
  if (outcome.status === 'draft-final' && !isTransient(outcome)) await versions.rememberUpgradeVerdict(draftId, outcome.reason, DRAFT_FINAL_TTL_SECONDS);
  return outcome;
}

async function directUpgrade(versions: VersionStore, draft: PublishedGame, request: UpgradeRequest): Promise<UpgradeOutcome> {
  const final = (reason: DraftFinalReason): UpgradeOutcome => ({ status: 'draft-final', reason });
  const draftId = draft.version.versionId;

  // Výpadek úložiště dřív, než se zaplatí model. Vyčerpaná kvóta ne – dítě se
  // do ní nepočítá (R11), takže odpověď `canPublish` tu nerozhoduje.
  try {
    await versions.canPublish();
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return final('STORE_UNAVAILABLE');
    throw thrown;
  }

  const directorStarted = performance.now();
  const directed = await getDirector(request.startedAt, request.caller)(request.sentence);
  const directorMs = performance.now() - directorStarted;
  if (directed.source === 'draft') return final(directed.fallbackReason ?? 'MODEL_UNAVAILABLE');
  if (gameSpecHash(directed.spec) === gameSpecHash(draft.spec)) return final('UNCHANGED');
  // Vylepšení nesmí vyměnit ovládání: běžec by se přepsal na mřížkovou hru
  // a hráči by se pod rukama změnila hra (R1, P25A).
  if ((directed.spec.control ?? 'tap_go') !== (draft.spec.control ?? 'tap_go')) return final('MALFORMED');

  const seeds = request.seed !== null ? [request.seed] : derivedSeeds(seedFrom(request.sentence.trim()));
  const published = await publishReadSpec(versions, directed.spec, seeds, draftId, {
    relation: 'upgrade',
    timings: { ackMs: request.ackMs, draftReadyMs: request.draftReadyMs, directorMs, source: directed.source },
  });
  if (!published.ok) return final(REFUSAL_REASON[published.response.status] ?? 'FAILED');
  return { status: 'ready', versionId: published.value.game.version.versionId };
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
  if (known !== undefined) return known.done.then((outcome) => (isTransient(outcome) ? { status: 'pending' } : outcome));

  const attempt = runUpgrade(versions, draft, request).catch((thrown: unknown): UpgradeOutcome => {
    console.error(`[play] upgrade of ${draftId} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    return { status: 'draft-final', reason: 'FAILED' };
  });
  const job: Job = { done: attempt, outcome: null };
  const remembered = attempt.then((outcome) => {
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
  return job.outcome ?? { status: 'pending' };
}
