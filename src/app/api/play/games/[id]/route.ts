/**
 * `GET /api/play/games/:id` – celá publikovaná hra: verze, spec, blueprint,
 * zpráva o kvalitě, děti a rodokmen od kořene. Verze je neměnná, proto se
 * odpověď smí minutu cachovat na hraně; `children` tím může být o minutu
 * pozadu, což je navigace, ne pravda o hře.
 *
 * I čtení má bránu: páku `snapshots` (vypne ji `all`) a strop frekvence –
 * jeden `GET` stojí tři příkazy úložiště a bez stropu by šel točit bez konce.
 */

import { notFound, VERSION_ID_PATTERN } from '../../_errors';
import { admit, store } from '../../_publish';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = await admit(request, 'snapshots');
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return notFound();

  const versions = store();
  const game = await versions.get(id);
  if (game === null) return notFound();

  const [children, lineage] = await Promise.all([versions.childrenOf(id), versions.lineageOf(id)]);
  return Response.json(
    { ...game, children, lineage },
    { headers: { 'cache-control': 'public, max-age=0, s-maxage=60' } },
  );
}
