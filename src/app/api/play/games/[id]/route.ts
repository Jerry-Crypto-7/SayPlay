/**
 * `GET /api/play/games/:id` – celá publikovaná hra: verze, spec, blueprint,
 * zpráva o kvalitě, děti a rodokmen od kořene. Verze je neměnná, proto se
 * odpověď smí minutu cachovat na hraně; `children` tím může být o minutu
 * pozadu, což je navigace, ne pravda o hře – a stejně tak `bestDare` a `beat`.
 *
 * I čtení má bránu: páku `snapshots` (vypne ji `all`) a strop frekvence –
 * jeden `GET` stojí pět a víc příkazů úložiště a bez stropu by šel točit bez konce.
 */

import { beatOf } from '@/play/version';

import { notFound, VERSION_ID_PATTERN } from '../../_errors';
import { admit, markVolatileStore, store } from '../../_publish';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = await admit(request, 'snapshots');
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return markVolatileStore(notFound());

  const versions = store();
  const game = await versions.get(id);
  if (game === null) return markVolatileStore(notFound());

  // `bestDare` (P37C T2): „duch nejlepšího“ – id výzvy, skóre a tiky; běh čte `GET …/dare/:dareId`.
  // `beat` (P37C T5): „N% beat this“, nebo `null` pod deseti pokusy.
  const [children, lineage, bestDare, heat] = await Promise.all([versions.childrenOf(id), versions.lineageOf(id), versions.bestDare(id), versions.loopHeat([id])]);
  return markVolatileStore(
    Response.json({ ...game, children, lineage, bestDare, beat: beatOf(heat.get(id)) }, { headers: { 'cache-control': 'public, max-age=0, s-maxage=60' } }),
  );
}
