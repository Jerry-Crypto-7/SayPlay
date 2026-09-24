/**
 * Remix vlastní větou (P27C T4): věta, kterou čip nepozná, jde modelu jako
 * RFC 6902 záplata nad rodičem (`buildRemixRequest`). Práce běží na pozadí
 * se stejným vzorem jako upgrade (`_upgrade.ts`): jedna práce na klíč
 * `(rodič, normalizovaná věta)` v mapě na `globalThis`, dotaz na stav podle
 * `job`. Dvojí odeslání tak nezaplatí model dvakrát – ani na jiné instanci,
 * protože stav práce leží i v úložišti (T4a).
 *
 * Slib práce nikdy neodmítne – každá chyba je `final` s důvodem.
 *
 * Podtržítko v názvu: Next.js soubor nebere jako route.
 */

import { createHash } from 'node:crypto';

import { after } from 'next/server';
import { createPatch } from 'rfc6902';

import { blockingIssues, critique, type RepairIssue } from '@/play/director';
import { buildRemixRequest, describeRemix, remixKeeps } from '@/play/director/remix';
import { applyRepairAnswer, buildRepairRequest } from '@/play/director/repair';
import { gameSpecHash, type GameSpecV1 } from '@/play/spec';
import { type PublishedGame, type VersionStore, VersionStoreUnavailable } from '@/play/version';

import { callDirectorModel, DIRECTOR_BUDGET_MS } from './_director';
import { derivedSeeds, playabilityIssues, publishReadSpec, seedFrom } from './_publish';
import { DRAFT_FINAL_TTL_SECONDS, UPGRADE_DEADLINE_SLACK_MS } from './_upgrade';

export type RemixFinalReason = 'MODEL_UNAVAILABLE' | 'MALFORMED' | 'UNREPAIRED' | 'UNCHANGED' | 'NOT_PLAYABLE' | 'STORE_UNAVAILABLE' | 'UNASKED_CHANGE' | 'FAILED';

export type RemixOutcome =
  | { readonly status: 'ready'; readonly versionId: string; readonly changed: readonly string[] }
  | { readonly status: 'final'; readonly reason: RemixFinalReason };

export type RemixStatus = RemixOutcome | { readonly status: 'pending'; readonly job: string; readonly deadlineAt: string };

/** Výpadky, po kterých má nové odeslání téže věty dostat nový pokus; ostatní jsou verdikt o větě. */
const TRANSIENT: ReadonlySet<RemixFinalReason> = new Set(['MODEL_UNAVAILABLE', 'STORE_UNAVAILABLE', 'FAILED']);

interface Job {
  readonly parentId: string;
  readonly startedAt: number;
  readonly done: Promise<RemixOutcome>;
  outcome: RemixOutcome | null;
}

export const MAX_REMEMBERED_REMIXES = 1000;

const JOBS = Symbol.for('worldstream.play.remixes');

function jobs(): Map<string, Job> {
  const holder = globalThis as { [JOBS]?: Map<string, Job> };
  holder[JOBS] ??= new Map();
  return holder[JOBS];
}

/**
 * Konce bez verdiktu o větě (výpadek, vypínač, vyčerpaný počet volajícího,
 * úložiště) mají vlastní malou mapu: stojí útočníka nic, a v hlavní mapě by
 * vytlačily cizí hotové práce (T4b). Nové odeslání je stejně spustí znovu.
 */
export const MAX_REMEMBERED_REFUSALS = 200;

const REFUSALS = Symbol.for('worldstream.play.remix-refusals');

function refusals(): Map<string, { readonly parentId: string; readonly outcome: RemixOutcome }> {
  const holder = globalThis as { [REFUSALS]?: Map<string, { readonly parentId: string; readonly outcome: RemixOutcome }> };
  holder[REFUSALS] ??= new Map();
  return holder[REFUSALS];
}

/** Jen pro testy. */
export function __resetRemixes(): void {
  jobs().clear();
  refusals().clear();
}

/** Jen pro testy: kolik prací drží hlavní mapa. */
export function __rememberedRemixes(): number {
  return jobs().size;
}

/** Věta z těla: řídicí znaky pryč, mezery sjednocené, ořezaná. */
export function cleanRemixSentence(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `job` je hash rodiče a normalizované věty. Mapa prací je jen zrychlení
 * v jednom procesu; stav práce se zapisuje i do úložiště (`StoredRemix`), aby
 * ji našel restart i jiná instance (T4a).
 * SHA-256, ne `canonicalHash` (32bitový FNV): kolize by jiné větě vrátila
 * cizí výsledek.
 */
export function remixJobId(parentId: string, sentence: string): string {
  return createHash('sha256').update(JSON.stringify([parentId, sentence.toLowerCase()])).digest('hex').slice(0, 32);
}

const DEADLINE_MS = DIRECTOR_BUDGET_MS + UPGRADE_DEADLINE_SLACK_MS;

function pendingOf(id: string, startedAt: number): RemixStatus {
  return { status: 'pending', job: id, deadlineAt: new Date(startedAt + DEADLINE_MS).toISOString() };
}

/** Práce v úložišti: `outcome: null` = někde běží, do lhůty (pak záznam vyprší). */
interface StoredRemix {
  readonly parentId: string;
  readonly startedAt: number;
  readonly outcome: RemixOutcome | null;
  /** Zaplacené dítě, na kterém přechodný konec přerušil práci – příští pokus pokračuje od něj (T4c). */
  readonly child?: GameSpecV1;
}

/** Jak dlouho se hotové dítě najde podle věty; hra sama žije v úložišti déle. */
export const REMIX_READY_TTL_SECONDS = 7 * 24 * 3600;
const PENDING_TTL_SECONDS = Math.ceil(DEADLINE_MS / 1000);
/** Jak často se instance, která práci nespustila, ptá úložiště, jestli už doběhla. */
export const STORE_POLL_MS = 1_000;

/**
 * Klíč v prostoru verdiktů upgradu: rozhraní úložiště patří stopě B a tohle
 * se do něj vejde beze změny. `remix:` ho oddělí od id verzí (samé hex znaky).
 */
const recordKey = (job: string): string => `remix:${job}`;

async function readRecord(versions: VersionStore, job: string): Promise<StoredRemix | null> {
  const text = await versions.upgradeVerdict(recordKey(job));
  if (text === null) return null;
  try {
    const record = JSON.parse(text) as Partial<StoredRemix> | null;
    return typeof record?.parentId === 'string' && typeof record.startedAt === 'number' ? (record as StoredRemix) : null;
  } catch {
    return null;
  }
}

/** Výpadek i konec běhu jen krátce – nové odeslání pak dostane nový pokus; verdikt o větě hodinu, hotové dítě týden. */
function writeRecord(versions: VersionStore, job: string, record: StoredRemix): Promise<void> {
  const { outcome } = record;
  const ttl = outcome === null || (outcome.status === 'final' && TRANSIENT.has(outcome.reason)) ? PENDING_TTL_SECONDS : outcome.status === 'ready' ? REMIX_READY_TTL_SECONDS : DRAFT_FINAL_TTL_SECONDS;
  return versions.rememberUpgradeVerdict(recordKey(job), JSON.stringify(record), ttl);
}

/** Práci spustila jiná instance: čeká na její výsledek v úložišti do lhůty. */
async function followStored(versions: VersionStore, job: string, parentId: string, startedAt: number): Promise<RemixOutcome> {
  while (Date.now() < startedAt + DEADLINE_MS) {
    await new Promise((resolve) => setTimeout(resolve, STORE_POLL_MS));
    const stored = await readRecord(versions, job);
    if (stored === null) break;
    if (stored.outcome !== null) return stored.outcome;
  }
  return final('FAILED', parentId, 'the instance running this remix did not finish it');
}

function final(reason: RemixFinalReason, parentId: string, detail: string): RemixOutcome {
  console.warn(`[play] remix of ${parentId} ended ${reason}: ${detail.slice(0, 300)}`);
  return { status: 'final', reason };
}

/** Proč by hra neprošla: blokující nálezy kritika, jinak ověření robotem. */
function issuesOf(spec: GameSpecV1, seeds: readonly number[]): readonly RepairIssue[] {
  const blocks = blockingIssues(critique(spec));
  return blocks.length > 0 ? blocks : playabilityIssues(spec, seeds);
}

interface RemixRequest {
  readonly sentence: string;
  readonly startedAt: number;
  readonly caller: string;
}

/**
 * `resume` = dítě, které už předchozí pokus zaplatil a stráž pustila (T4c) –
 * první volání se pak přeskočí. `keep` dostane každé takové dítě, aby ho
 * přechodný konec mohl uložit pro příští pokus.
 */
async function runRemix(versions: VersionStore, parent: PublishedGame, request: RemixRequest, resume: GameSpecV1 | null, keep: (child: GameSpecV1) => void): Promise<RemixOutcome> {
  const parentId = parent.version.versionId;
  try {
    await versions.canPublish();
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return final('STORE_UNAVAILABLE', parentId, 'store unavailable before the call');
    throw thrown;
  }

  const seeds = derivedSeeds(seedFrom({ parentId, sentence: request.sentence.toLowerCase() }));
  let child: GameSpecV1;
  if (resume !== null) {
    child = resume;
  } else {
    const answer = await callDirectorModel(request.startedAt, request.caller, buildRemixRequest(request.sentence, parent.spec), request.sentence);
    if (!answer.ok) return final(answer.reason === 'MALFORMED_RESPONSE' ? 'MALFORMED' : 'MODEL_UNAVAILABLE', parentId, `${answer.reason}: ${answer.detail}`);
    const applied = applyRepairAnswer(parent.spec, answer.body);
    if (!applied.ok) return final('MALFORMED', parentId, `${applied.reason}: ${applied.detail}`);
    child = applied.spec;
    // Stráž dřív než opravné kolo: dítě, které mění, o co věta nežádala, nemá cenu opravovat za peníze.
    if (!remixKeeps(parent.spec, child, request.sentence)) return final('UNASKED_CHANGE', parentId, 'the patch changes control, goal or hero');
    keep(child);
  }

  let issues = issuesOf(child, seeds);
  if (issues.length > 0) {
    const repair = await callDirectorModel(request.startedAt, request.caller, buildRepairRequest(child, issues), request.sentence);
    if (!repair.ok) return final('MODEL_UNAVAILABLE', parentId, `repair: ${repair.reason}: ${repair.detail}`);
    const repaired = applyRepairAnswer(child, repair.body);
    if (!repaired.ok) return final('UNREPAIRED', parentId, `repair: ${repaired.reason}: ${repaired.detail}`);
    if (!remixKeeps(parent.spec, repaired.spec, request.sentence)) return final('UNASKED_CHANGE', parentId, 'the repair changes control, goal or hero');
    child = repaired.spec;
    keep(child);
    issues = issuesOf(child, seeds);
    if (issues.length > 0) return final(blockingIssues(critique(child)).length > 0 ? 'UNREPAIRED' : 'NOT_PLAYABLE', parentId, issues.map((issue) => `${issue.code}: ${issue.evidence}`).join('; '));
  }
  if (gameSpecHash(child) === gameSpecHash(parent.spec)) return final('UNCHANGED', parentId, 'the model returned the parent');

  const published = await publishReadSpec(versions, child, seeds, parentId);
  if (!published.ok) {
    const reason: RemixFinalReason = published.response.status === 503 ? 'STORE_UNAVAILABLE' : published.response.status === 422 ? 'NOT_PLAYABLE' : 'FAILED';
    return final(reason, parentId, (published.issues ?? [String(published.response.status)]).join('; '));
  }
  return { status: 'ready', versionId: published.value.game.version.versionId, changed: describeRemix(parent.spec, createPatch(parent.spec, child)) };
}

/** Strop platí na doběhlé práce: nával běžících (každá do chvíle odmítnutí) nesmí vytlačit cizí hotovou (T4b). */
function forgetSettled(map: Map<string, Job>): void {
  let settled = 0;
  for (const job of map.values()) if (job.outcome !== null) settled += 1;
  for (const [id, job] of map) {
    if (settled <= MAX_REMEMBERED_REMIXES) return;
    if (job.outcome !== null) {
      map.delete(id);
      settled -= 1;
    }
  }
}

/**
 * Práce pro rodiče a větu: běžící nebo doběhlá z paměti, jinak nová. Kontrola
 * a zápis do mapy jsou v jednom synchronním kroku, takže dvě souběžná odeslání
 * zavolají model jednou. Přechodný konec (výpadek) se přepíše novým pokusem.
 */
export function startRemix(versions: VersionStore, parent: PublishedGame, request: RemixRequest): RemixStatus {
  const map = jobs();
  const id = remixJobId(parent.version.versionId, request.sentence);
  const known = map.get(id);
  if (known !== undefined && !(known.outcome?.status === 'final' && TRANSIENT.has(known.outcome.reason))) return pendingOf(id, known.startedAt);

  const done = settle(versions, parent, request, id);
  const job: Job = { parentId: parent.version.versionId, startedAt: request.startedAt, done, outcome: null };
  map.set(id, job);
  const remembered = done.then((outcome) => {
    job.outcome = outcome;
    if (outcome.status === 'final' && TRANSIENT.has(outcome.reason)) {
      if (map.get(id) === job) map.delete(id);
      const refused = refusals();
      refused.delete(id);
      refused.set(id, { parentId: job.parentId, outcome });
      if (refused.size > MAX_REMEMBERED_REFUSALS) refused.delete(refused.keys().next().value!);
    }
    forgetSettled(map);
  });
  // `after()` jako u upgradu: na serverless se instance po odpovědi zmrazí.
  try {
    after(remembered);
  } catch {
    console.warn(`[play] after() unavailable, remix ${id} runs unguarded`);
    void remembered;
  }
  return pendingOf(id, job.startedAt);
}

/**
 * Úložiště dřív než model: hotové dítě a verdikt o větě se vrátí, běžící práce
 * jiné instance se dočká. Jinak se práce zapíše jako běžící, spustí a výsledek
 * zapíše. Přechodný konec v úložišti znamená nový pokus.
 */
async function settle(versions: VersionStore, parent: PublishedGame, request: RemixRequest, id: string): Promise<RemixOutcome> {
  const parentId = parent.version.versionId;
  try {
    const stored = await readRecord(versions, id);
    let child: GameSpecV1 | null = null;
    if (stored !== null && stored.parentId === parentId) {
      if (stored.outcome === null) return await followStored(versions, id, parentId, stored.startedAt);
      if (!(stored.outcome.status === 'final' && TRANSIENT.has(stored.outcome.reason))) return stored.outcome;
      child = stored.child ?? null;
    }
    const resume = child;
    await writeRecord(versions, id, { parentId, startedAt: request.startedAt, outcome: null, child: resume ?? undefined });
    const outcome = await runRemix(versions, parent, request, resume, (kept) => {
      child = kept;
    });
    const again = outcome.status === 'final' && TRANSIENT.has(outcome.reason);
    await writeRecord(versions, id, { parentId, startedAt: request.startedAt, outcome, child: again ? (child ?? undefined) : undefined });
    return outcome;
  } catch (thrown) {
    return final('FAILED', parentId, thrown instanceof Error ? thrown.message : String(thrown));
  }
}

/** Stav práce `job` pod rodičem `parentId` – z paměti procesu, jinak z úložiště; `null` = nikdo o ní neví. */
export async function remixStatus(versions: VersionStore, parentId: string, job: string): Promise<RemixStatus | null> {
  const known = jobs().get(job);
  if (known !== undefined && known.parentId === parentId) return known.outcome ?? pendingOf(job, known.startedAt);
  const refused = refusals().get(job);
  if (refused !== undefined && refused.parentId === parentId) return refused.outcome;
  const stored = await readRecord(versions, job);
  if (stored === null || stored.parentId !== parentId) return null;
  return stored.outcome ?? pendingOf(job, stored.startedAt);
}
