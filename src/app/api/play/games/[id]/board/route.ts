/**
 * `GET /api/play/games/:id/board` – žebříček hry (P44B T6): nejvýš `BOARD_SHOWN` nejlepších
 * ověřených běhů, které zapsaly dveře výzvy (`POST …/dare`). Řádek
 * `{ place, nickname, score, ticks, dareId, you }`: přezdívka jen přes `shownNickname`, `dareId`
 * vede na ducha přes `GET …/dare/:dareId` (`null` = běh v úložišti neleží), `you` jen u hráče
 * z platně podepsané cookie. Id hráče ani cookie do těla nejdou.
 *
 * Táž brána jako čtení hry (páka `snapshots`). Odpověď se liší podle cookie, proto `no-store`.
 * Výpadek úložiště je `503` – prázdný žebříček by lhal.
 */

import { shownNickname } from '@/play/player/nickname';
import { VersionStoreUnavailable } from '@/play/version';
import { playerOf } from '@/server/player-identity';

import { fail, notFound, VERSION_ID_PATTERN } from '../../../_errors';
import { admit, markVolatileStore, store } from '../../../_publish';

/** Kolik řádků žebříček ukáže. */
export const BOARD_SHOWN = 10;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = await admit(request, 'snapshots');
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return markVolatileStore(notFound());

  // Žebříček dřív než hra: `get` výpadek spolkne jako `null` a z výpadku by bylo 404 (nález revize fáze 1).
  const versions = store();
  let top;
  try {
    top = await versions.board(id, BOARD_SHOWN);
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return fail(503, 'STORE_UNAVAILABLE', 'the leaderboard is unavailable right now');
    throw thrown;
  }
  if ((await versions.get(id)) === null) return markVolatileStore(notFound());
  const you = playerOf(request);
  // simplified: jedno čtení hráče na řádek (až 10 příkazů Upstash na žebříček); dávka přes `getMany`, až čtení žebříčku zdraží úložiště.
  const players = await Promise.all(top.map(({ playerId }) => versions.getPlayer(playerId)));
  const rows = top.map(({ playerId, place, score, ticks, dareId }, index) => ({
    place,
    nickname: shownNickname(playerId, players[index]?.nickname),
    score,
    ticks,
    dareId,
    you: playerId === you,
  }));
  return markVolatileStore(Response.json({ rows }, { headers: { 'cache-control': 'no-store' } }));
}
