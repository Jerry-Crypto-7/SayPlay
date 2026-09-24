/**
 * Remix vlastní větou (P27C T4): věta, kterou čip nepozná, jde modelu jako
 * RFC 6902 záplata nad rodičem (`buildRemixRequest`). Práce běží na pozadí
 * se stejným vzorem jako upgrade (`_upgrade.ts`): jedna práce na klíč
 * `(rodič, normalizovaná věta)` v mapě na `globalThis`, dotaz na stav podle
 * `job`. Dvojí odeslání tak nezaplatí model dvakrát.
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
import { UPGRADE_DEADLINE_SLACK_MS } from './_upgrade';

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

/** Jen pro testy. */
export function __resetRemixes(): void {
  jobs().clear();
}

/** Věta z těla: řídicí znaky pryč, mezery sjednocené, ořezaná. */
export function cleanRemixSentence(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `job` je hash rodiče a normalizované věty – týž klíč z kteréhokoli procesu.
 * SHA-256, ne `canonicalHash` (32bitový FNV): kolize by jiné větě vrátila
 * cizí výsledek.
 */
export function remixJobId(parentId: string, sentence: string): string {
  return createHash('sha256').update(JSON.stringify([parentId, sentence.toLowerCase()])).digest('hex').slice(0, 32);
}

function pendingOf(id: string, job: Job): RemixStatus {
  return { status: 'pending', job: id, deadlineAt: new Date(job.startedAt + DIRECTOR_BUDGET_MS + UPGRADE_DEADLINE_SLACK_MS).toISOString() };
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

async function runRemix(versions: VersionStore, parent: PublishedGame, request: RemixRequest): Promise<RemixOutcome> {
  const parentId = parent.version.versionId;
  try {
    await versions.canPublish();
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return final('STORE_UNAVAILABLE', parentId, 'store unavailable before the call');
    throw thrown;
  }

  const seeds = derivedSeeds(seedFrom({ parentId, sentence: request.sentence.toLowerCase() }));
  const answer = await callDirectorModel(request.startedAt, request.caller, buildRemixRequest(request.sentence, parent.spec), request.sentence);
  if (!answer.ok) return final(answer.reason === 'MALFORMED_RESPONSE' ? 'MALFORMED' : 'MODEL_UNAVAILABLE', parentId, `${answer.reason}: ${answer.detail}`);
  const applied = applyRepairAnswer(parent.spec, answer.body);
  if (!applied.ok) return final('MALFORMED', parentId, `${applied.reason}: ${applied.detail}`);
  let child = applied.spec;
  // Stráž dřív než opravné kolo: dítě, které mění, o co věta nežádala, nemá cenu opravovat za peníze.
  if (!remixKeeps(parent.spec, child, request.sentence)) return final('UNASKED_CHANGE', parentId, 'the patch changes control, goal or hero');

  let issues = issuesOf(child, seeds);
  if (issues.length > 0) {
    const repair = await callDirectorModel(request.startedAt, request.caller, buildRepairRequest(child, issues), request.sentence);
    if (!repair.ok) return final('MODEL_UNAVAILABLE', parentId, `repair: ${repair.reason}: ${repair.detail}`);
    const repaired = applyRepairAnswer(child, repair.body);
    if (!repaired.ok) return final('UNREPAIRED', parentId, `repair: ${repaired.reason}: ${repaired.detail}`);
    if (!remixKeeps(parent.spec, repaired.spec, request.sentence)) return final('UNASKED_CHANGE', parentId, 'the repair changes control, goal or hero');
    child = repaired.spec;
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

function forgetSettled(map: Map<string, Job>): void {
  for (const [id, job] of map) {
    if (map.size <= MAX_REMEMBERED_REMIXES) return;
    if (job.outcome !== null) map.delete(id);
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
  if (known !== undefined && !(known.outcome?.status === 'final' && TRANSIENT.has(known.outcome.reason))) return pendingOf(id, known);

  const done = runRemix(versions, parent, request).catch((thrown: unknown): RemixOutcome => final('FAILED', parent.version.versionId, thrown instanceof Error ? thrown.message : String(thrown)));
  const job: Job = { parentId: parent.version.versionId, startedAt: request.startedAt, done, outcome: null };
  map.set(id, job);
  const remembered = done.then((outcome) => {
    job.outcome = outcome;
    forgetSettled(map);
  });
  // `after()` jako u upgradu: na serverless se instance po odpovědi zmrazí.
  try {
    after(remembered);
  } catch {
    console.warn(`[play] after() unavailable, remix ${id} runs unguarded`);
    void remembered;
  }
  return pendingOf(id, job);
}

/** Stav práce `job` pod rodičem `parentId`; `null` = proces o ní neví. */
export function remixStatus(parentId: string, job: string): RemixStatus | null {
  const known = jobs().get(job);
  if (known === undefined || known.parentId !== parentId) return null;
  return known.outcome ?? pendingOf(job, known);
}
