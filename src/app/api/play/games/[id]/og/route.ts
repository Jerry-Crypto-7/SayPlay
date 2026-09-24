/**
 * `GET /api/play/games/:id/og` – náhled hry pro sdílený odkaz (PNG 1200×630).
 *
 * Tytéž brány jako čtení hry (páka `snapshots`, strop frekvence na dveřích
 * `play`) a tatáž 404 pro neznámé i tvarově špatné id. Obraz kreslí titul,
 * hrdinu, prostředí a ovládání neměnné verze (P27B T6), proto smí být
 * `immutable`. Když render selže, přijde paletový PNG podle nálady s
 * `x-og-fallback: 1` a jen hodinovou cache – ať se opravený render dostane ven.
 * Náhled bez obrázku hrdiny (ač ho katalog má) nebo s textem mimo písmo Geist
 * má tutéž hodinovou cache a `x-og-partial: 1`.
 */

import { notFound, VERSION_ID_PATTERN } from '../../../_errors';
import { assetOriginFrom, gamePreviewPng, ogPngFor } from '../../../_og';
import { admit, store } from '../../../_publish';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = await admit(request, 'snapshots');
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return notFound();

  const game = await store().get(id);
  if (game === null) return notFound();

  const preview = await gamePreviewPng(id, game.spec, assetOriginFrom(process.env));
  const png = preview?.png ?? ogPngFor(game.spec.theme.mood);
  const SHORT = 'public, max-age=0, s-maxage=3600';
  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      'content-length': String(png.length),
      ...(preview === null
        ? { 'cache-control': SHORT, 'x-og-fallback': '1' }
        : preview.complete
          ? { 'cache-control': 'public, max-age=31536000, immutable' }
          : // Chybí hrdina nebo písmo: ukázat, co je, ale za hodinu to zkusit znovu (nález revize T6-1).
            { 'cache-control': SHORT, 'x-og-partial': '1' }),
    },
  });
}
