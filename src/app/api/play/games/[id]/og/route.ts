/**
 * `GET /api/play/games/:id/og` – náhled hry pro sdílený odkaz (PNG 1200×630).
 *
 * Tytéž brány jako čtení hry (páka `snapshots`, strop frekvence na dveřích
 * `play`) a tatáž 404 pro neznámé i tvarově špatné id. Obraz je karta výzvy
 * kitu Sayplay (P34 T7, dřív titulní obrázek P27B T6) z neměnné verze: název,
 * hrdina na barvě scény, odznak s časem a logo – proto smí být `immutable`.
 * Když render selže, přijde paletový PNG podle nálady s `x-og-fallback: 1`
 * a jen hodinovou cache – ať se opravený render dostane ven. Náhled bez
 * obrázku hrdiny (ač ho katalog má), bez písma Roboto nebo loga, nebo
 * s názvem mimo písmo má tutéž hodinovou cache a `x-og-partial: 1`.
 *
 * Odkaz výzvy (`?dare=`, P36B T8) dostane na odznak výsledek kamaráda – jen
 * výzvy téhle hry. Parametr `dare`, který nevyšel (cizí, prošlá, neplatná
 * výzva, i výpadek úložiště – `getDare` vrací `null`), dostane obyčejnou
 * kartu s hodinovou cache: výzva se může objevit až po výpadku. Výzva s autorem
 * (P44B T7) nese nad odznakem „Ada dares you“ a také jen hodinovou cache.
 */

import { shownNickname } from '@/play/player/nickname';
import { DARE_ID_PATTERN } from '@/play/version';

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

  const dareId = new URL(request.url).searchParams.get('dare');
  const record = dareId !== null && DARE_ID_PATTERN.test(dareId) ? await store().getDare(dareId) : null;
  const dare = record !== null && record.versionId === id ? record : null;
  // Jméno autora výzvy (P44B T7) jen přes `shownNickname` – žádný jiný text z úložiště na kartu.
  const by = dare?.by === undefined ? undefined : shownNickname(dare.by, (await store().getPlayer(dare.by))?.nickname);

  const preview = await gamePreviewPng(id, game.spec, assetOriginFrom(process.env), dare, by);
  const png = preview?.png ?? ogPngFor(game.spec.theme.mood);
  const SHORT = 'public, max-age=0, s-maxage=3600';
  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      'content-length': String(png.length),
      ...(preview === null
        ? { 'cache-control': SHORT, 'x-og-fallback': '1' }
        : !preview.complete
          ? // Chybí hrdina nebo písmo: ukázat, co je, ale za hodinu to zkusit znovu (nález revize T6-1).
            { 'cache-control': SHORT, 'x-og-partial': '1' }
          : // Výzva, která nevyšla, i karta se jménem autora (přezdívku smí změnit) žijí hodinu.
            dareId !== null && (dare === null || by !== undefined)
            ? { 'cache-control': SHORT }
            : { 'cache-control': 'public, max-age=31536000, immutable' }),
    },
  });
}
