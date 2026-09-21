/**
 * `GET /api/play/games/:id/og` – náhled hry pro sdílený odkaz (PNG 1200×630).
 *
 * Tytéž brány jako čtení hry (páka `snapshots`, strop frekvence na dveřích
 * `play`) a tatáž 404 pro neznámé i tvarově špatné id. Obraz závisí jen na
 * náladě neměnné verze, proto se smí hodinu cachovat na hraně.
 */

import { notFound, VERSION_ID_PATTERN } from '../../../_errors';
import { ogPngFor } from '../../../_og';
import { admit, store } from '../../../_publish';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = await admit(request, 'snapshots');
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return notFound();

  const game = await store().get(id);
  if (game === null) return notFound();

  const png = ogPngFor(game.spec.theme.mood);
  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      'content-length': String(png.length),
      'cache-control': 'public, max-age=0, s-maxage=3600',
    },
  });
}
