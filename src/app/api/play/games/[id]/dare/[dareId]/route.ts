/**
 * `GET /api/play/games/:id/dare/:dareId` – uložená výzva i s během pro přehrání
 * ducha (P37C T1). Skóre, tiky a hash konce spočítal server přehráním při
 * zápisu (`POST …/dare`); klient z `replay` pustí `replayLive` a dojde k témuž
 * hashi. `replay: null` = výzva bez ducha (zapsaná před P37C, nad stropem
 * bajtů nebo nad denním stropem duchů) – skóre k pokoření platí dál.
 *
 * Táž brána jako čtení hry (páka `snapshots`, strop frekvence `play`): jedno
 * čtení stojí jeden příkaz úložiště. Výzva jiné hry je tady neznámá. Záznam se
 * zapisuje jednou (`SET NX`), proto se smí minutu cachovat na hraně.
 */

import { DARE_ID_PATTERN } from '@/play/version';

import { fail, notFound, VERSION_ID_PATTERN } from '../../../../_errors';
import { admit, markVolatileStore, store } from '../../../../_publish';

export async function GET(request: Request, context: { params: Promise<{ id: string; dareId: string }> }): Promise<Response> {
  const refused = await admit(request, 'snapshots');
  if (refused !== null) return refused;

  const { id, dareId } = await context.params;
  if (!VERSION_ID_PATTERN.test(id) || !DARE_ID_PATTERN.test(dareId)) return markVolatileStore(notFound());

  const dare = await store().getDare(dareId);
  if (dare === null || dare.versionId !== id) return markVolatileStore(fail(404, 'NOT_FOUND', 'this dare does not exist or has expired'));

  const { score, ticks, hash, liveChanges, createdAt } = dare;
  return markVolatileStore(
    Response.json(
      { dareId, versionId: id, score, ticks, hash, liveChanges, createdAt, replay: dare.replay ?? null },
      { headers: { 'cache-control': 'public, max-age=0, s-maxage=60' } },
    ),
  );
}
