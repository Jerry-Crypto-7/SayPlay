/**
 * `GET /api/play/games/:id/upgrade` – je autorská verze návrhu hotová?
 *
 * `{ status: 'pending', deadlineAt, queued? }` (ISO, P27C T1; `queued` = pořadí
 * ve frontě režiséra, P53 T3) | `{ status: 'ready', versionId }` |
 * `{ status: 'draft-final', reason }`. Proces, který POST viděl, odpoví
 * z paměti hned. Proces, který o návrhu neví (serverless, restart), práci
 * **sám spustí** z věty uložené u návrhu a počká nejvýš `UPGRADE_WAIT_MS`;
 * potom `pending` a další dotaz ji najde v paměti. `pending` nese i hru ze čtení
 * (`reading: { versionId }`, P58D T2), jakmile vznikne – čekání se pak vrátí hned.
 * Řetěz mikroher (P58E T2) končí `{ status: 'draft-final', reason: 'CHAIN', reading? }` – AI verzi nemá, hra ze čtení
 * jde s koncem, protože práce řetězu doběhne hned po čtení.
 *
 * Dotaz může spustit placenou režii, proto jde přes páku `sessions` (zápis),
 * ne `snapshots` – vypínač publikací zastaví i upgrade.
 */

import { fail, notFound, VERSION_ID_PATTERN } from '../../../_errors';
import { admit, directorCallerOf, store } from '../../../_publish';
import { stepsOf } from '@/play/director/progress';

import { knownUpgrade, pendingSince, readingArrival, type UpgradeStatus, upgradeOf, upgradeQueueId } from '../../../_upgrade';

const UPGRADE_WAIT_MS = 25_000;

/** Práce spuštěná odsud běží v `after()` a potřebuje týž strop jako POST (R7). */
export const maxDuration = 300;

/** `pending` nese od P73C T2 i `steps`: kroky režie v pořadí (`progress.ts`); klient bez nich je přeskočí. */
function answer(status: UpgradeStatus, id: string): Response {
  const steps = status.status === 'pending' ? stepsOf(upgradeQueueId(id)) : [];
  return Response.json(steps.length === 0 ? status : { ...status, steps }, { headers: { 'cache-control': 'no-store' } });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const startedAt = Date.now();
  const refused = await admit(request);
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return notFound();

  const known = knownUpgrade(id);
  if (known !== null) return answer(known, id);

  const versions = store();
  const draft = await versions.get(id);
  if (draft === null) return notFound();
  // Řetěz mikroher AI verzi nemá (P56C T10, debata T9) – jeho práce jen přečte větu a skončí `CHAIN`, s hrou ze čtení (P58E T2).
  // Hra z hotového specu, remix nebo sama autorská verze: není co vylepšit.
  if (draft.origin === undefined || draft.relation !== undefined) return answer({ status: 'draft-final', reason: 'NOT_FROM_SENTENCE' }, id);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<UpgradeStatus>((resolve) => {
    timer = setTimeout(() => resolve(knownUpgrade(id) ?? pendingSince(startedAt)), UPGRADE_WAIT_MS);
  });
  const done = upgradeOf(versions, draft, { ...draft.origin, ackMs: null, draftReadyMs: null, startedAt, caller: directorCallerOf(request) });
  const reading = readingArrival(id).then(() => knownUpgrade(id) ?? pendingSince(startedAt));
  try {
    return answer(await Promise.race([done, waited, reading]), id);
  } finally {
    clearTimeout(timer);
  }
}
