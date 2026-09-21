/**
 * `GET /api/play/games/:id/upgrade` – je autorská verze návrhu hotová?
 *
 * `{ status: 'pending' }` | `{ status: 'ready', versionId }` |
 * `{ status: 'draft-final', reason }`. Proces, který POST viděl, odpoví
 * z paměti hned. Proces, který o návrhu neví (serverless, restart), práci
 * **sám spustí** z věty uložené u návrhu a počká nejvýš `UPGRADE_WAIT_MS`;
 * potom `pending` a další dotaz ji najde v paměti.
 *
 * Dotaz může spustit placenou režii, proto jde přes páku `sessions` (zápis),
 * ne `snapshots` – vypínač publikací zastaví i upgrade.
 */

import { notFound, VERSION_ID_PATTERN } from '../../../_errors';
import { admit, directorCallerOf, store } from '../../../_publish';
import { knownUpgrade, type UpgradeStatus, upgradeOf } from '../../../_upgrade';

const UPGRADE_WAIT_MS = 25_000;

/** Práce spuštěná odsud běží v `after()` a potřebuje týž strop jako POST (R7). */
export const maxDuration = 300;

function answer(status: UpgradeStatus): Response {
  return Response.json(status, { headers: { 'cache-control': 'no-store' } });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const startedAt = Date.now();
  const refused = await admit(request);
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return notFound();

  const known = knownUpgrade(id);
  if (known !== null) return answer(known);

  const versions = store();
  const draft = await versions.get(id);
  if (draft === null) return notFound();
  // Hra z hotového specu, remix nebo sama autorská verze: není co vylepšit.
  if (draft.origin === undefined || draft.relation !== undefined) return answer({ status: 'draft-final', reason: 'NOT_FROM_SENTENCE' });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<UpgradeStatus>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'pending' }), UPGRADE_WAIT_MS);
  });
  const done = upgradeOf(versions, draft, { ...draft.origin, ackMs: null, draftReadyMs: null, startedAt, caller: directorCallerOf(request) });
  try {
    return answer(await Promise.race([done, waited]));
  } finally {
    clearTimeout(timer);
  }
}
