/**
 * `POST /api/play/games/:id/report` – nahlášení hry z feedu (P54A T11).
 *
 * Bez těla, odpověď `204`. Hlas volajícího se počítá jednou na hru
 * (`VersionStore.reportGame`); hru, kterou nahlásí `REPORT_HIDE_VOTES` různých
 * volajících, feed neukáže (`GET /api/play/games` k `PLAY_FEED_HIDE`). Odkaz na
 * hru dál hraje. Vestavěnou hru skryje jen provozovatel: hlas se přijme a nezapíše.
 * Bez důvěryhodné adresy (mimo Vercel) si klíč volajícího píše volající sám
 * (`x-forwarded-for`), takže všichni takoví mají dohromady jeden hlas.
 */

import { VersionStoreUnavailable } from '@/play/version';
import { BUILTIN_IDS } from '@/play/version/builtin';
import { trustedCallerKey } from '@/server/rate-limit';

import { fail, notFound, VERSION_ID_PATTERN } from '../../../_errors';
import { admit, markVolatileStore, store, voterOf } from '../../../_publish';

/** Hlas všech volajících bez důvěryhodné adresy; `voterOf` dává 16 hex znaků, nesrazí se. */
const UNTRUSTED_VOTER = 'untrusted';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = await admit(request);
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return notFound();
  const versions = store();
  if ((await versions.get(id)) === null) return markVolatileStore(notFound());
  if (BUILTIN_IDS.has(id)) return new Response(null, { status: 204 });
  try {
    await versions.reportGame(id, trustedCallerKey(request) === null ? UNTRUSTED_VOTER : voterOf(request));
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return fail(503, 'STORE_UNAVAILABLE', 'the report could not be saved right now');
    throw thrown;
  }
  return new Response(null, { status: 204 });
}
