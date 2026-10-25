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

import { RECENT_CAP, VersionStoreUnavailable } from '@/play/version';
import { BUILTIN_IDS } from '@/play/version/builtin';
import { trustedCallerKey } from '@/server/rate-limit';

import { fail, notFound, VERSION_ID_PATTERN } from '../../../_errors';
import { admit, markVolatileStore, store, voterOf } from '../../../_publish';

/** Hlas všech volajících bez důvěryhodné adresy; `voterOf` dává 16 hex znaků, nesrazí se. */
const UNTRUSTED_VOTER = 'untrusted';

/**
 * Hlas jen z vlastní stránky (nález revize /ship P54A): POST bez těla smí poslat i cizí web
 * (`no-cors`) a každý jeho návštěvník by hlasoval ze své adresy. Prohlížeč posílá
 * `sec-fetch-site`, starší aspoň `origin`; volání bez obojího (curl) prohlížeč nezneužije.
 */
function crossSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site !== 'same-origin' && site !== 'none';
  const origin = request.headers.get('origin');
  if (origin === null) return false;
  // `request.url` za `next start` nese adresu, na které server poslouchá, ne tu veřejnou – rozhoduje `host`.
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (crossSite(request)) return fail(403, 'FORBIDDEN', 'report a game from the game page');
  const refused = await admit(request);
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return notFound();
  const versions = store();
  const game = await versions.get(id);
  if (game === null) return markVolatileStore(notFound());
  if (BUILTIN_IDS.has(id)) return new Response(null, { status: 204 });
  // Hru, která do feedu nesmí, feed neukáže: hlas se přijme a nezapíše, jinak by vlastní hry
  // vytlačily skutečné hlasy ze seznamu provozovatele (`REPORTED_KEPT`). Hra ze čtení (P58D T1) do feedu nesmí.
  if ((game.relation === undefined || game.relation === 'reading') && !(await versions.recent(RECENT_CAP)).some((row) => row.versionId === id && row.curated === true)) {
    return new Response(null, { status: 204 });
  }
  try {
    await versions.reportGame(id, trustedCallerKey(request) === null ? UNTRUSTED_VOTER : voterOf(request));
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return fail(503, 'STORE_UNAVAILABLE', 'the report could not be saved right now');
    throw thrown;
  }
  return new Response(null, { status: 204 });
}
