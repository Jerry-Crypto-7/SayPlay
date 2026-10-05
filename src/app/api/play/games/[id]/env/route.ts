/**
 * `GET /api/play/games/:id/env` – vlastní panorama hry, jejíž prostředí
 * knihovna nezná (P29C T7). Bez parametru stav:
 *
 *   { status: 'library' }                      knihovna prostředí zná, nic se negeneruje
 *   { status: 'pending' }                      služba na něm pracuje
 *   { status: 'ready', id, url, low, horizon } hotové, soubory jdou touto route;
 *                                              bez služby předpečené z `public/play/env/`
 *   { status: 'failed' | 'unavailable' }       zůstává knihovní panorama
 *
 * `?file=full|low` vrátí obrázek. Klíč služby prohlížeč nikdy nevidí.
 * Brány jako u čtení hry: páka `snapshots` a strop frekvence.
 */

import { customEnvFile, customEnvState } from '../../../_env';
import { notFound, VERSION_ID_PATTERN } from '../../../_errors';
import { admit, markVolatileStore, store } from '../../../_publish';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = await admit(request, 'snapshots');
  if (refused !== null) return refused;

  const { id } = await context.params;
  if (!VERSION_ID_PATTERN.test(id)) return markVolatileStore(notFound());
  const game = await store().get(id);
  if (game === null) return markVolatileStore(notFound());
  const setting = game.spec.theme.setting;

  const size = new URL(request.url).searchParams.get('file');
  if (size !== null) {
    if (size !== 'full' && size !== 'low') return notFound();
    return (await customEnvFile(setting, size)) ?? notFound();
  }

  const state = await customEnvState(setting);
  const base = `/api/play/games/${id}/env`;
  // Předpečené panorama nese vlastní statickou adresu a ta vyhraje.
  const body = state.status === 'ready' ? { url: `${base}?file=full`, low: `${base}?file=low`, ...state } : state;
  return Response.json(body, { headers: { 'cache-control': 'no-store' } });
}
