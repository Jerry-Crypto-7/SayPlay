/**
 * `GET /api/worldstream/snapshots/:hash` — **hotový svět, který přežije vypnutí
 * všeho ostatního** (P15 T30, design book §22.4).
 *
 * Tyhle dveře jsou schválně to nejhloupější v celém serveru. Nevolají model,
 * nezakládají relaci, nezvedají revizi, neberou slot souběhu a nesahají na
 * strop utrácení — přečtou záznam z paměti a pošlou ho. Právě proto smějí běžet
 * dál ve chvíli, kdy je zbytek vypnutý: §22.4 chce, aby existující sdílené
 * světy zůstaly čitelné, *„dokud běží storage a viewer"*.
 *
 * ## Co sem klient nesmí poslat, protože by to bylo k něčemu
 *
 * Adresa je jediný vstup a je to **otisk obsahu**, tedy hodnota, kterou server
 * spočítal sám (`snapshot-store.ts`). Nebere se odsud žádný klíč, žádná adresa
 * poskytovatele a žádná cesta na disku — kdyby ano, byly by to dveře, kterými
 * návštěvník řekne serveru, kam má sáhnout, a to je celá třída vad, kterou
 * tenhle produkt nemá.
 *
 * Neznámá adresa a vypršená adresa dostanou **tutéž** odpověď. Rozlišit je
 * znamená potvrdit, že takový svět kdysi existoval.
 *
 * ## Cachovat se smí, ale ne navždy — a ten rozdíl je celý o stažení z oběhu
 *
 * Obsah pod adresou se nemůže změnit, protože adresa je z něj spočítaná, takže
 * `immutable` na rok vypadalo jako správná odpověď. **Není**, a nález nezávislé
 * revize 3. 9. 2026 (`VERDICT: blocking`) říká proč: tenhle soubor zavádí dvě
 * cesty, jak svět z oběhu stáhnout — vypínač `off: ["all"]` a `SHARED_WORLD_TTL_MS`
 * (24 h, „výslovné vypršení" z §22.4) — a **obě sahají jen na origin**. Rok
 * v `immutable` znamená, že jednou stažený otisk servíruje CDN dál i s vypnutým
 * demem; u obsahu, který má jít pryč (uklouzlá moderace, něčí osobní věc), je
 * to rok bez páky.
 *
 * Kompromis je `s-maxage` v řádu desítek sekund: nápor prvního průchodu odbaví
 * pořád CDN, ale stažení z oběhu se propíše nejpozději za minutu. `max-age=0`
 * navrch říká prohlížeči, ať se ptá vždycky — jeho vlastní záložka je jediné
 * místo, kde stará kopie nikomu nevadí.
 */

import { killState } from '@/server/kill-switch';
import { readSharedWorld } from '@/worldstream/snapshot-store';

export const runtime = 'nodejs';

/**
 * Jak dlouho smí sdílená cache držet svět, o kterém se origin už nemusí
 * dozvědět. Nejvýš minuta — to je horní mez toho, jak dlouho po stažení
 * z oběhu ještě někdo uvidí starý obsah.
 */
export const SNAPSHOT_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, must-revalidate';

export async function GET(
  _request: Request,
  context: { params: Promise<{ hash: string }> },
): Promise<Response> {
  // **Jediný vypínač, který na tyhle dveře sahá, je `all`.** Rozbitý ovládací
  // soubor je nechá běžet schválně; viz `kill-switch.ts`.
  if ((await killState(process.env)).snapshots)
    return Response.json(
      { error: { code: 'SERVICE_DISABLED', message: 'this deployment is switched off right now' } },
      { status: 503 },
    );

  const { hash } = await context.params;
  const world = readSharedWorld(hash, Date.now());

  if (world === null)
    return Response.json(
      { error: { code: 'UNKNOWN_SNAPSHOT', message: 'no shared world lives at that address' } },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );

  return Response.json(
    {
      hash: world.hash,
      title: world.title,
      sessionSeed: world.sessionSeed,
      blueprint: world.blueprint,
    },
    { headers: { 'cache-control': SNAPSHOT_CACHE_CONTROL } },
  );
}
