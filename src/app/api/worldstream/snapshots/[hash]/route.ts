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
 * ## Cachovat se smí navždy, a to není optimalizace
 *
 * Obsah pod adresou se nemůže změnit, protože adresa je z něj spočítaná. Proto
 * `immutable` — a proto tyhle dveře unesou nápor, který by relace neunesla: po
 * prvním průchodu je odbaví CDN a server se jich už ani nedotkne.
 */

import { killState } from '@/server/kill-switch';
import { readSharedWorld } from '@/worldstream/snapshot-store';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ hash: string }> },
): Promise<Response> {
  // **Jediný vypínač, který na tyhle dveře sahá, je `all`.** Rozbitý ovládací
  // soubor je nechá běžet schválně; viz `kill-switch.ts`.
  if (killState(process.env).snapshots)
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
    { headers: { 'cache-control': 'public, max-age=31536000, immutable' } },
  );
}
