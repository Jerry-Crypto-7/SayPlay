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
  | 'PUBLISH_QUOTA'
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
}

interface Job {
  readonly done: Promise<UpgradeOutcome>;
  outcome: UpgradeOutcome | null;
}

/**
 * Kolik prací si proces pamatuje. Nad tím zapomene nejstarší **doběhlou** –
 * běžící zůstává, jinak by druhý dotaz spustil druhou placenou režii.
 * Zapomenutá práce se z úložiště dohledá jako `ready`; `draft-final` se při
 * dalším dotazu spočítá znovu.
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

const REFUSAL_REASON: Readonly<Record<number, DraftFinalReason>> = { 422: 'NOT_PLAYABLE', 429: 'PUBLISH_QUOTA', 503: 'STORE_UNAVAILABLE' };

async function runUpgrade(versions: VersionStore, draft: PublishedGame, request: UpgradeRequest): Promise<UpgradeOutcome> {
  const draftId = draft.version.versionId;
  const existing = await publishedUpgrade(versions, draftId);
  if (existing !== null) return { status: 'ready', versionId: existing };

  // Denní strop dřív, než se zaplatí model – dítě by úložiště stejně odmítlo.
  try {
    if (!(await versions.canPublish())) return { status: 'draft-final', reason: 'PUBLISH_QUOTA' };
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return { status: 'draft-final', reason: 'STORE_UNAVAILABLE' };
    throw thrown;
  }

  const directorStarted = performance.now();
  const directed = await getDirector()(request.sentence);
  const directorMs = performance.now() - directorStarted;
  if (directed.source === 'draft') return { status: 'draft-final', reason: directed.fallbackReason ?? 'MODEL_UNAVAILABLE' };
  if (gameSpecHash(directed.spec) === gameSpecHash(draft.spec)) return { status: 'draft-final', reason: 'UNCHANGED' };

  const seeds = request.seed !== null ? [request.seed] : derivedSeeds(seedFrom(request.sentence.trim()));
  const published = await publishReadSpec(versions, directed.spec, seeds, draftId, {
    relation: 'upgrade',
    timings: { ackMs: request.ackMs, draftReadyMs: request.draftReadyMs, directorMs, source: directed.source },
  });
  if (!published.ok) return { status: 'draft-final', reason: REFUSAL_REASON[published.response.status] ?? 'FAILED' };
  return { status: 'ready', versionId: published.value.game.version.versionId };
}

/**
 * Práce pro návrh: běžící nebo doběhlá z paměti, jinak nová. Kontrola
 * a zápis do mapy jsou v jednom synchronním kroku, takže dva souběžné dotazy
 * na týž návrh spustí režiséra jednou.
 */
export function upgradeOf(versions: VersionStore, draft: PublishedGame, request: UpgradeRequest): Promise<UpgradeOutcome> {
  const map = jobs();
  const draftId = draft.version.versionId;
  const known = map.get(draftId);
  if (known !== undefined) return known.done;

  const job: Job = {
    done: runUpgrade(versions, draft, request).catch((thrown: unknown): UpgradeOutcome => {
      console.error(`[play] upgrade of ${draftId} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
      return { status: 'draft-final', reason: 'FAILED' };
    }),
    outcome: null,
  };
  const remembered = job.done.then((outcome) => {
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
