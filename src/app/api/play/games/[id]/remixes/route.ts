/**
 * `GET /api/play/games/:id/remixes` – řetěz remixů hry (P44B T11): nejvýš `REMIXES_SHOWN`
 * nejnovějších dětí z `childrenOf` jako `{ versionId, title, chips, top }`. `chips` = rozdíl
 * proti téhle hře (`remixChips`), `top` = první řádek **vlastního** žebříčku remixu
 * (`{ nickname, score, ticks }`, `null` = bez běhů nebo nečitelný). Autorská verze od AI
 * (`relation: 'upgrade'`) remix hráče není. Id hráče do těla nejde.
 *
 * Táž brána jako čtení hry (páka `snapshots`). Odpověď je pro všechny stejná a jde o navigaci,
 * ne o pravdu o hře – smí se minutu cachovat na hraně jako hra sama.
 */

import { shownNickname } from '@/play/player/nickname';
import { type VersionStore, VersionStoreUnavailable } from '@/play/version';
import { remixChips } from '@/play/version/remix-diff';

import { notFound, VERSION_ID_PATTERN } from '../../../_errors';
import { admit, markVolatileStore, store } from '../../../_publish';

/** Kolik remixů řetěz ukáže. */
export const REMIXES_SHOWN = 12;

/** Nejlepší řádek žebříčku hry se jménem; `null` = žádný běh, nebo ho úložiště teď nevydá. */
async function topOf(versions: VersionStore, versionId: string): Promise<{ nickname: string; score: number; ticks: number } | null> {
  let first;
  try {
    [first] = await versions.board(versionId, 1);
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return null;
    throw thrown;
  }
  if (first === undefined) return null;
  return { nickname: shownNickname(first.playerId, (await versions.getPlayer(first.playerId))?.nickname), score: first.score, ticks: first.ticks };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = await admit(request, 'snapshots');
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return markVolatileStore(notFound());

  const versions = store();
  const game = await versions.get(id);
  if (game === null) return markVolatileStore(notFound());

  // simplified: až 4 čtení úložiště na remix (hra, žebříček, běh, hráč), ~50 příkazů Upstash za odpověď bez hrany; dávka přes `getMany`, až se list otevírá často.
  // O jedno dítě víc: autorská verze od AI vzniká z návrhu jednou a místo remixu nezabere.
  const newest = (await versions.childrenOf(id)).slice(-(REMIXES_SHOWN + 1)).reverse();
  const children = await Promise.all(newest.map((childId) => versions.get(childId)));
  const remixes = await Promise.all(
    children
      .filter((child) => child !== null && child.relation !== 'upgrade')
      .slice(0, REMIXES_SHOWN)
      .map(async (child) => ({
        versionId: child!.version.versionId,
        title: child!.version.title,
        chips: remixChips(game.spec, child!.spec),
        top: await topOf(versions, child!.version.versionId),
      })),
  );
  return markVolatileStore(Response.json({ remixes }, { headers: { 'cache-control': 'public, max-age=0, s-maxage=60' } }));
}
