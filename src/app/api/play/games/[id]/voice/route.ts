/**
 * `GET /api/play/games/:id/voice` – cíl hry přečtený hlasem vypravěče (P29D T11).
 *
 * Tytéž brány jako náhled (páka `snapshots`, strop frekvence na dveřích `play`)
 * a tatáž 404 pro neznámé i tvarově špatné id. Hotová nahrávka je Ogg a smí
 * být `immutable` (verze se nemění, id nahrávky je hash textu). Dokud hotová
 * není, nebo služba chybí, přijde 204 bez cache – hra mlčí a příště se zeptá znovu.
 */

import { notFound, VERSION_ID_PATTERN } from '../../../_errors';
import { admit, store } from '../../../_publish';
import { fetchVoice } from '../../../_voice';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = await admit(request, 'snapshots');
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return notFound();

  const game = await store().get(id);
  if (game === null) return notFound();

  const audio = await fetchVoice(game.spec);
  if (audio === null) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  return new Response(audio, {
    headers: {
      'content-type': 'audio/ogg',
      'content-length': String(audio.length),
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
